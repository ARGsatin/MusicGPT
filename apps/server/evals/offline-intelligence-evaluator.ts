import type {
  ListeningConstraint,
  LearningReceipt,
  MusicAction,
  MusicActionPlan,
  MusicCommandOutcome,
  MusicCommandResult,
  NowPlayingState,
  RadioPlanItem,
  Track,
  TrackReference
} from "@musicgpt/shared";
import { OpenAiDjAssistant, type AiDjIntent } from "../src/aiDjAssistant.js";
import { MusicCommandModule, type MusicCommandRuntime } from "../src/musicCommand.js";
import { StateRepository } from "../src/stateRepository.js";

export interface EvaluationExpectation {
  action: MusicAction;
  outcome: MusicCommandOutcome;
  stepActions: MusicAction[];
  sideEffects: OfflineSideEffect[];
  assertions: string[];
}

export interface EvaluationChannel {
  endpoint: string;
  input: string;
  expected: EvaluationExpectation;
}

export interface EvaluationTrajectory {
  id: string;
  category: string;
  fixture: MusicActionPlan;
  text: EvaluationChannel;
  voice: EvaluationChannel;
}

export type OfflineSideEffect = "learning" | "playback" | "queue";

const REAL_FALLBACK_PLANNER_CASE_IDS = new Set([
  "cmd-001",
  "cmd-002",
  "cmd-003",
  "cmd-025",
  "cmd-040",
  "fix-007",
  "fix-011"
]);

interface ChannelVerdict {
  channel: "text" | "voice";
  passed: boolean;
  errorCodes: string[];
}

interface TrajectoryVerdict {
  caseId: string;
  category: string;
  status: "passed" | "failed";
  channels: ChannelVerdict[];
}

export interface OfflineEvaluationSummary {
  mode: "offline";
  total: number;
  executed: number;
  channelExecutions: number;
  fallbackPlannerChannelExecutions: number;
  passed: number;
  failed: number;
  releaseReady: boolean;
  results: TrajectoryVerdict[];
  privacy: "case_ids_and_verdicts_only";
}

export async function runOfflineIntelligenceEvaluation(options: {
  simulateFailureCaseId?: string;
} = {}): Promise<OfflineEvaluationSummary> {
  const moduleUrl = new URL("./intelligence-trajectories.mjs", import.meta.url).href;
  const loaded = await import(moduleUrl) as { intelligenceTrajectories: readonly EvaluationTrajectory[] };
  const trajectories = loaded.intelligenceTrajectories;
  if (trajectories.length !== 150) throw new Error(`offline_corpus_size_${trajectories.length}`);

  const repository = new StateRepository(":memory:");
  seedRecentReferences(repository);
  const results: TrajectoryVerdict[] = [];
  let fallbackPlannerChannelExecutions = 0;

  for (const trajectory of trajectories) {
    const channels: ChannelVerdict[] = [];
    for (const channel of ["text", "voice"] as const) {
      const runtime = new DeterministicMusicRuntime(
        trajectory.fixture,
        REAL_FALLBACK_PLANNER_CASE_IDS.has(trajectory.id),
        createInitialNow(),
        trajectory.id === "src-017"
      );
      const command = new MusicCommandModule(repository, runtime);
      const result = await command.execute({
        turnId: `offline-${trajectory.id}-${channel}`,
        commandId: `command-${trajectory.id}-${channel}`,
        request: trajectory[channel].input,
        mode: channel === "text" ? "text_suggest" : "voice_direct"
      });
      const publicEnvelope = channel === "text" ? textEnvelope(result) : { result };
      const expectation = trajectory[channel].expected;
      const errorCodes = evaluateResult(publicEnvelope, result, runtime.sideEffects, expectation);
      fallbackPlannerChannelExecutions += runtime.fallbackPlannerCalls;
      if (options.simulateFailureCaseId === trajectory.id && channel === "text") {
        errorCodes.push("simulated_failure");
      }
      channels.push({ channel, passed: errorCodes.length === 0, errorCodes });
    }
    results.push({
      caseId: trajectory.id,
      category: trajectory.category,
      status: channels.every((item) => item.passed) ? "passed" : "failed",
      channels
    });
  }

  const passed = results.filter((item) => item.status === "passed").length;
  return {
    mode: "offline",
    total: trajectories.length,
    executed: results.length,
    channelExecutions: results.reduce((sum, item) => sum + item.channels.length, 0),
    fallbackPlannerChannelExecutions,
    passed,
    failed: results.length - passed,
    releaseReady: passed === trajectories.length,
    results,
    privacy: "case_ids_and_verdicts_only"
  };
}

export class DeterministicMusicRuntime implements MusicCommandRuntime {
  readonly sideEffects = new Set<OfflineSideEffect>();
  readonly appliedConstraints: ListeningConstraint[] = [];
  fallbackPlannerCalls = 0;
  private now: NowPlayingState;
  private readonly fallbackAssistant = new OpenAiDjAssistant({ model: "offline-fallback" });

  constructor(
    private readonly fixturePlan: MusicActionPlan,
    private readonly useFallbackPlanner: boolean,
    initialNow: NowPlayingState = createInitialNow(),
    private readonly failFavorite = false
  ) {
    this.now = initialNow;
  }

  getNow(): NowPlayingState {
    return this.now;
  }

  async plan(message: string): Promise<MusicActionPlan> {
    if (this.useFallbackPlanner) {
      this.fallbackPlannerCalls += 1;
      return this.fallbackAssistant.plan(message, {
        messages: [],
        nowTrack: this.now.track,
        queue: this.now.queue
      });
    }
    return this.fixturePlan;
  }

  async classify(): Promise<AiDjIntent> {
    return { type: "chat" };
  }

  async searchSongs(query: string): Promise<Track[]> {
    return [fixtureTrack(query)];
  }

  resolveTrack(trackId: TrackReference): Track | undefined {
    if (trackId === "qq:0039MnYb0qxYhV") {
      return {
        id: "0039MnYb0qxYhV",
        trackKey: "qq:0039MnYb0qxYhV",
        source: "qq",
        sourceId: "0039MnYb0qxYhV",
        title: "QQ Fixture",
        artists: ["Fixture Artist"]
      };
    }
    return [this.now.track, ...this.now.queue.map((item) => item.track), ...["Recent One", "Recent Two", "Recent Three"].map(fixtureTrack)]
      .find((track) => track && (track.trackKey === trackId || track.id === trackId));
  }

  async playTrack(track: Track): Promise<NowPlayingState> {
    this.sideEffects.add("playback");
    this.now = {
      ...this.now,
      track,
      paused: false,
      decision: fixtureDecision(track)
    };
    return this.now;
  }

  async setFavorite(_trackId: TrackReference, favorite: boolean): Promise<LearningReceipt> {
    if (this.failFavorite) throw new Error("injected_favorite_failure");
    this.sideEffects.add("learning");
    this.now = { ...this.now, isFavorite: favorite };
    return receipt(favorite ? "已记录收藏。" : "已记录取消收藏。");
  }

  async replay(_trackId: TrackReference): Promise<void> {
    this.sideEffects.add("playback");
    this.now = { ...this.now, startedAt: "2026-08-25T00:00:00.000Z" };
  }

  async handleAction(
    _request: string,
    step: MusicActionPlan["actions"][number],
    constraints: ListeningConstraint[]
  ): Promise<MusicCommandResult> {
    this.appliedConstraints.push(...constraints);
    this.sideEffects.add("learning");
    if (step.action === "update_session_intent") {
      this.sideEffects.add("queue");
      this.now = { ...this.now, queue: [...this.now.queue].reverse() };
    }
    return {
      action: step.action,
      outcome: "executed",
      summary: "确定性离线偏好操作已执行。",
      now: this.now,
      learningReceipt: receipt("确定性离线学习回执。")
    };
  }

  async handleIntent(
    _request: string,
    intent: AiDjIntent,
    _mode?: "text_suggest" | "voice_direct",
    constraints: ListeningConstraint[] = []
  ): Promise<MusicCommandResult> {
    this.appliedConstraints.push(...constraints);
    switch (intent.type) {
      case "pause":
        this.sideEffects.add("playback");
        this.now = { ...this.now, paused: true };
        return result("pause", "executed", this.now);
      case "resume":
        this.sideEffects.add("playback");
        this.now = { ...this.now, paused: false };
        return result("resume", "executed", this.now);
      case "skip": {
        this.sideEffects.add("playback");
        const next = this.now.queue[0]?.track ?? fixtureTrack("Skipped Fixture");
        this.now = { ...this.now, track: next, queue: this.now.queue.slice(1), paused: false, decision: fixtureDecision(next) };
        return result("skip", "executed", this.now);
      }
      case "replan":
        this.sideEffects.add("queue");
        this.now = { ...this.now, queue: [...this.now.queue].reverse() };
        return result("replan", "executed", this.now);
      case "play_specific":
      case "play_by_description":
      case "play_atmosphere": {
        const track = fixtureTrack(intent.type === "play_specific" ? intent.query : intent.type);
        return {
          action: intent.type,
          outcome: "answered",
          summary: "确定性离线候选。",
          now: this.now,
          suggestion: {
            id: `suggestion-${intent.type}`,
            track,
            reason: "确定性离线候选",
            createdAt: "2026-08-25T00:00:00.000Z"
          }
        };
      }
      case "comment_current":
        return result("comment_current", "answered", this.now);
      case "chat":
        return result("noop", "answered", this.now);
    }
  }
}

export function evaluateResult(
  publicEnvelope: unknown,
  resultValue: MusicCommandResult,
  actualSideEffects: Set<OfflineSideEffect>,
  expected: EvaluationExpectation
): string[] {
  const errors: string[] = [];
  if (resultValue.action !== expected.action) errors.push("action_mismatch");
  if (resultValue.outcome !== expected.outcome) errors.push("outcome_mismatch");
  const actualSteps = resultValue.actions?.map((item) => item.action) ?? [resultValue.action];
  if (actualSteps.join("|") !== expected.stepActions.join("|")) errors.push("step_actions_mismatch");
  const expectedEffects = expected.outcome === "failed" ? expected.sideEffects.filter((effect) => effect !== "learning") : expected.sideEffects;
  if ([...actualSideEffects].sort().join("|") !== [...expectedEffects].sort().join("|")) {
    errors.push("side_effect_mismatch");
  }
  if (expected.outcome === "needs_confirmation") {
    if (!resultValue.clarification) errors.push("clarification_missing");
    if (actualSideEffects.size > 0) errors.push("clarification_had_side_effect");
  }
  for (const assertion of expected.assertions) {
    if (!hasVisibleSeam(publicEnvelope, assertion)) errors.push(`missing_seam:${assertion}`);
  }
  return errors;
}

export function textEnvelope(command: MusicCommandResult): unknown {
  return {
    result: {
      response: {
        action: command.action,
        now: command.now,
        command,
        ...(command.learningReceipt ? { learningReceipt: command.learningReceipt } : {}),
        ...(command.clarification ? { clarification: command.clarification } : {})
      }
    }
  };
}

function hasVisibleSeam(root: unknown, expression: string): boolean {
  let current: unknown = root;
  for (const part of expression.split(".")) {
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (expression.endsWith("now.track")) return typeof current === "object" && current !== null;
  if (expression.endsWith("now.queue")) return Array.isArray(current);
  return current !== null && current !== undefined;
}

export function createInitialNow(): NowPlayingState {
  const current = fixtureTrack("Current Fixture");
  return {
    track: current,
    queue: ["Queue One", "Queue Two", "Queue Three"].map(planItem),
    paused: false,
    decision: fixtureDecision(current)
  };
}

function fixtureTrack(label: string): Track {
  const safeId = label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 50) || "track";
  const qq = /qq/iu.test(label);
  return {
    id: qq ? `qq:${safeId}` : `ncm:${safeId}`,
    trackKey: qq ? `qq:${safeId}` : `ncm:${safeId}`,
    recordingKey: `recording:${safeId}`,
    source: qq ? "qq" : "ncm",
    sourceId: safeId,
    title: label,
    artists: ["Offline Fixture Artist"],
    durationMs: 180_000,
    songUrl: `https://offline.invalid/${safeId}.mp3`
  };
}

function planItem(label: string): RadioPlanItem {
  return { track: fixtureTrack(label), score: 1, reason: "offline fixture" };
}

function fixtureDecision(track: Track) {
  return {
    decisionId: `decision-${String(track.id)}`,
    policyVersion: "offline-fixture-v1",
    evidence: [{ type: "context" as const, label: "离线上下文", strength: 1, correctable: true }]
  };
}

function receipt(summary: string): LearningReceipt {
  return {
    receiptId: `receipt-${summary.length}`,
    scope: "session",
    changedSignals: [],
    replacedQueueCount: 0,
    summary,
    undoToken: `undo-${summary.length}`,
    undoExpiresAt: "2026-08-25T00:10:00.000Z"
  };
}

function result(action: MusicAction, outcome: MusicCommandOutcome, now: NowPlayingState): MusicCommandResult {
  return { action, outcome, summary: "确定性离线结果。", now };
}

export function seedRecentReferences(repository: StateRepository): void {
  const at = "2026-08-25T00:00:00.000Z";
  for (const [index, trackId] of ["ncm:recent-one", "ncm:recent-two", "ncm:recent-three"].entries()) {
    repository.addPlayEvent({
      type: "play_start",
      trackId,
      at: new Date(Date.parse(at) + index * 1_000).toISOString(),
      eventId: `offline-recent-${index}`
    });
  }
}
