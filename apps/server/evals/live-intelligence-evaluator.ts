import type { AiDjAssistant, AiDjContext } from "../src/aiDjAssistant.js";
import type { ListeningConstraint, MusicActionPlan, NowPlayingState, Track, TrackReference } from "@musicgpt/shared";
import { MusicCommandModule } from "../src/musicCommand.js";
import { StateRepository } from "../src/stateRepository.js";
import {
  createInitialNow,
  DeterministicMusicRuntime,
  evaluateResult,
  seedRecentReferences,
  textEnvelope,
  type EvaluationTrajectory
} from "./offline-intelligence-evaluator.js";

export type LiveEvaluationCase = EvaluationTrajectory;
export type LiveEvaluationChannel = "text" | "voice";
export const LIVE_EVALUATOR_VERSION = "isolated-music-command-v6";
export const LIVE_CHANNEL_SET = ["text", "voice"] as const;

export interface SanitizedLiveCaseVerdict {
  caseId: string;
  status: "passed" | "failed";
  actionMatches: boolean;
  seamMatches: boolean;
  unsafeAction: boolean;
  textPassed: boolean;
  voicePassed: boolean;
  channelConsistent: boolean;
  errorCode?: string;
  errorCodes?: string[];
}

export interface LiveIntelligenceEvaluation {
  schemaVersion: 2;
  evaluatorVersion: typeof LIVE_EVALUATOR_VERSION;
  corpusHash: string;
  channelSet: typeof LIVE_CHANNEL_SET;
  policyVersion: "listening-policy-v1";
  provider: string | null;
  model: string | null;
  generatedAt: string;
  source: string;
  modelPlanExecutions: number;
  commandChannelExecutions: number;
  results: SanitizedLiveCaseVerdict[];
}

export async function runLiveIntelligenceEvaluation(options: {
  assistant: Pick<AiDjAssistant, "plan" | "status">;
  cases: readonly LiveEvaluationCase[];
  timeoutMs: number;
}): Promise<LiveIntelligenceEvaluation> {
  if (options.cases.length !== 25) {
    throw new Error(`live_release_corpus_size_${options.cases.length}`);
  }
  if (!options.assistant.plan) {
    throw new Error("live_planner_unavailable");
  }

  const results: SanitizedLiveCaseVerdict[] = [];
  for (const evaluationCase of options.cases) {
    results.push(await evaluateIsolatedCase(evaluationCase, options));
  }

  const status = options.assistant.status();
  return {
    schemaVersion: 2,
    evaluatorVersion: LIVE_EVALUATOR_VERSION,
    corpusHash: hashLiveEvaluationCorpus(options.cases),
    channelSet: LIVE_CHANNEL_SET,
    policyVersion: "listening-policy-v1",
    provider: typeof status.provider === "string" ? status.provider.slice(0, 40) : null,
    model: typeof status.model === "string" ? status.model.slice(0, 80) : null,
    generatedAt: new Date().toISOString(),
    source: "live-isolated-text-and-voice-music-command-evaluation",
    modelPlanExecutions: options.cases.length,
    commandChannelExecutions: options.cases.length * LIVE_CHANNEL_SET.length,
    results
  };
}

export function hashLiveEvaluationCorpus(cases: readonly {
  id: string;
  category: string;
  text: { input: string; expected: unknown };
  voice: { input: string; expected: unknown };
}[]): string {
  const releaseContract = cases.map((item) => ({
    id: item.id,
    category: item.category,
    text: {
      input: item.text.input,
      expected: item.text.expected
    },
    voice: {
      input: item.voice.input,
      expected: item.voice.expected
    }
  }));
  return createHash("sha256").update(JSON.stringify(releaseContract)).digest("hex");
}

async function evaluateIsolatedCase(
  evaluationCase: LiveEvaluationCase,
  options: {
    assistant: Pick<AiDjAssistant, "plan" | "status">;
    timeoutMs: number;
  }
): Promise<SanitizedLiveCaseVerdict> {
  if (evaluationCase.text.input !== evaluationCase.voice.input) {
    return failedVerdict(evaluationCase.id, "channel_input_mismatch");
  }
  const initialNow = initialState(evaluationCase.id);
  const context: AiDjContext = {
    messages: evaluationCase.id === "fix-018" ? [
      { role: "user", text: "这首只是现在不合适", at: "2026-09-05T00:00:00.000Z" },
      { role: "assistant", text: "已记录为当前会话反馈，这条学习可以在十分钟内撤销。", at: "2026-09-05T00:00:01.000Z" }
    ] : [],
    nowTrack: initialNow.track,
    queue: initialNow.queue
  };

  try {
    const plan = await withTimeout(
      options.assistant.plan!(evaluationCase.text.input, context),
      options.timeoutMs
    );
    const text = await evaluateIsolatedChannel(evaluationCase, "text", plan, options.timeoutMs);
    const voice = await evaluateIsolatedChannel(evaluationCase, "voice", plan, options.timeoutMs);
    const channelConsistent = text.signature === voice.signature;
    const actionMatches = text.actionMatches && voice.actionMatches;
    const seamMatches = text.seamMatches && voice.seamMatches;
    const unsafeAction = text.unsafeAction || voice.unsafeAction;
    const passed = text.passed && voice.passed && channelConsistent;

    return {
      caseId: evaluationCase.id,
      status: passed ? "passed" : "failed",
      actionMatches,
      seamMatches,
      unsafeAction,
      textPassed: text.passed,
      voicePassed: voice.passed,
      channelConsistent,
      ...(passed
        ? {}
        : { errorCode: classifyCaseError(text, voice, channelConsistent, unsafeAction),
            errorCodes: [...new Set([...text.errorCodes, ...voice.errorCodes])] })
    };
  } catch (error) {
    return failedVerdict(
      evaluationCase.id,
      error instanceof LiveEvaluationTimeoutError ? "timeout" : "planner_or_command_error"
    );
  }
}

interface ChannelEvaluation {
  passed: boolean;
  actionMatches: boolean;
  seamMatches: boolean;
  unsafeAction: boolean;
  errorCodes: string[];
  signature: string;
}

async function evaluateIsolatedChannel(
  evaluationCase: LiveEvaluationCase,
  channel: LiveEvaluationChannel,
  plan: Awaited<ReturnType<NonNullable<AiDjAssistant["plan"]>>>,
  timeoutMs: number
): Promise<ChannelEvaluation> {
  const expectation = evaluationCase[channel];
  // Every channel execution gets a new runtime and a new in-memory idempotency
  // repository. Reusing the IDs is deliberate: accidental shared state makes
  // the second execution return the first channel/case's cached result.
  const repository = new StateRepository(":memory:");
  seedRecentReferences(repository);
  const initial = initialState(evaluationCase.id);
  const runtime = new ReleaseRuntime(plan, evaluationCase.id, initial);
  const command = new MusicCommandModule(repository, runtime);
  const result = await withTimeout(command.execute({
    turnId: "isolated-live-turn",
    commandId: "isolated-live-command",
    request: expectation.input,
    mode: channel === "text" ? "text_suggest" : "voice_direct"
  }), timeoutMs);
  const publicEnvelope = channel === "text" ? textEnvelope(result) : { result };
  const errorCodes = evaluateResult(publicEnvelope, result, runtime.sideEffects, expectation.expected);
  // Search ambiguity is resolved by MusicCommand after planning, so either
  // noop or play_specific may be the carrier of a zero-effect clarification.
  if (expectation.expected.outcome === "needs_confirmation" && result.outcome === "needs_confirmation" && result.clarification && runtime.sideEffects.size === 0) {
    for (const code of ["action_mismatch", "step_actions_mismatch"]) {
      const index = errorCodes.indexOf(code);
      if (index >= 0) errorCodes.splice(index, 1);
    }
  }
  const semanticErrors = releaseSemanticErrors(evaluationCase.id, plan, runtime.appliedConstraints, initial, result.now);
  errorCodes.push(...semanticErrors);
  const firstSnapshot = JSON.stringify(result);
  const playbackCount = runtime.playbackCount;
  const retried = await command.execute({ turnId: "isolated-live-turn", commandId: "isolated-live-command", request: expectation.input, mode: channel === "text" ? "text_suggest" : "voice_direct" });
  if (JSON.stringify(retried) !== firstSnapshot || runtime.playbackCount !== playbackCount) errorCodes.push("retry_changed_state");
  const actionMatches = !errorCodes.some((code) =>
    code === "action_mismatch" || code === "outcome_mismatch" || code === "step_actions_mismatch"
  );
  const seamMatches = !errorCodes.some((code) => code.startsWith("missing_seam:"));
  const unsafeAction = [...runtime.sideEffects].some((effect) => !expectation.expected.sideEffects.includes(effect)) ||
    (runtime.sideEffects.size > 0 && semanticErrors.some((code) => code === "wrong_learning_scope" || code === "wrong_feedback_reason" || code === "current_track_changed" || code === "explicit_constraint_lost")) ||
    errorCodes.includes("retry_changed_state");
  return {
    passed: errorCodes.length === 0 && !unsafeAction,
    actionMatches,
    seamMatches,
    unsafeAction,
    errorCodes,
    signature: JSON.stringify({
      action: result.action,
      outcome: result.outcome,
      steps: result.actions?.map((item) => item.action) ?? [result.action],
      sideEffects: [...runtime.sideEffects].sort(),
      track: result.now.track?.trackKey ?? result.now.track?.id,
      queue: result.now.queue.map((item) => item.track.trackKey ?? item.track.id),
      clarified: Boolean(result.clarification)
    })
  };
}

function initialState(caseId: string): NowPlayingState {
  const initial = createInitialNow();
  if (caseId === "ref-019") return { queue: [], paused: true }; // No identifiable current version: must ask.
  if (caseId === "cmd-029") initial.paused = true;
  return initial;
}

class ReleaseRuntime extends DeterministicMusicRuntime {
  playbackCount = 0;
  constructor(plan: MusicActionPlan, private readonly caseId: string, initial: NowPlayingState) {
    super(plan, false, initial, caseId === "src-017");
  }
  override resolveTrack(trackId: TrackReference): Track | undefined {
    if (trackId === "qq:0039MnYb0qxYhV") return { id: trackId, trackKey: trackId, title: "QQ Fixture", artists: ["Fixture Artist"] };
    return super.resolveTrack(trackId);
  }
  override async searchSongs(query: string): Promise<Track[]> {
    if (this.caseId === "ref-014") return [
      { id: 2001, title: "后来", artists: ["刘若英"] },
      { id: 2002, title: "后来", artists: ["另一位歌手"] }
    ];
    if (this.caseId === "ref-010") return [this.resolveTrack("qq:0039MnYb0qxYhV")!];
    if (this.caseId === "cmd-009") return [{ id: 2003, title: "富士山下", artists: ["陈奕迅"] }];
    return super.searchSongs(query);
  }
  override async playTrack(track: Track): Promise<NowPlayingState> {
    this.playbackCount++;
    return super.playTrack(track);
  }
}

function releaseSemanticErrors(
  id: string,
  plan: MusicActionPlan,
  appliedConstraints: readonly ListeningConstraint[],
  before: NowPlayingState,
  after: NowPlayingState
): string[] {
  const errors: string[] = [];
  const key = (now: NowPlayingState) => now.track?.trackKey ?? now.track?.id;
  const feedback = plan.actions.find((step) => step.feedbackReason);
  if (["fix-003", "fix-006", "src-006"].includes(id)) {
    if (feedback?.scope !== "session") errors.push("wrong_learning_scope");
    if (feedback?.feedbackReason !== (id === "fix-003" ? "wrong_for_now" : "playback_problem")) errors.push("wrong_feedback_reason");
  }
  if (["fix-001", "fix-003", "ctx-017", "ctx-021", "cmd-040"].includes(id) && key(before) !== key(after)) errors.push("current_track_changed");
  if (id === "cmd-009" && !after.track?.artists.includes("陈奕迅")) errors.push("wrong_artist");
  if (id === "ref-003" && key(after) !== "ncm:recent-two") errors.push("wrong_reference_target");
  if (id === "ref-016" && key(after) !== "ncm:recent-three") errors.push("wrong_reference_target");
  if (id === "ref-010" && key(after) !== "qq:0039MnYb0qxYhV") errors.push("wrong_reference_target");
  if (id === "cmd-012" && !plan.actions.some((step) => step.immediate === true)) errors.push("immediate_switch_missing");
  if (id === "ctx-017" && !plan.actions.some((step) => step.immediate === false)) errors.push("current_lock_missing");
  if (id === "cmd-021" && !plan.actions.some((step) => step.scope === "day")) errors.push("wrong_learning_scope");
  if (id === "cmd-025" && !plan.actions.some((step) => step.scope === "long_term")) errors.push("wrong_learning_scope");
  if (id === "cmd-026" && !appliedConstraints.some((constraint) => constraint.kind === "avoid" && constraint.hard && /器乐|instrumental|纯音乐/iu.test(constraint.value))) errors.push("explicit_constraint_lost");
  if (id === "cmd-035" && !appliedConstraints.some((constraint) => /女|female/iu.test(constraint.value) && constraint.hard)) errors.push("explicit_constraint_lost");
  return errors;
}

function classifyCaseError(
  text: ChannelEvaluation,
  voice: ChannelEvaluation,
  channelConsistent: boolean,
  unsafeAction: boolean
): string {
  if (unsafeAction) return "unsafe_action";
  if (!channelConsistent) return "channel_mismatch";
  return classifyError([...text.errorCodes, ...voice.errorCodes], false);
}

function classifyError(errorCodes: string[], unsafeAction: boolean): string {
  if (unsafeAction) return "unsafe_action";
  if (errorCodes.includes("action_mismatch")) return "action_mismatch";
  if (errorCodes.includes("outcome_mismatch")) return "outcome_mismatch";
  if (errorCodes.includes("step_actions_mismatch")) return "step_actions_mismatch";
  if (errorCodes.some((code) => code.startsWith("missing_seam:"))) return "public_seam_mismatch";
  if (errorCodes.includes("side_effect_mismatch")) return "side_effect_mismatch";
  if (errorCodes.includes("clarification_missing")) return "clarification_missing";
  if (errorCodes.includes("clarification_had_side_effect")) return "clarification_had_side_effect";
  return "unknown_mismatch";
}

function failedVerdict(caseId: string, errorCode: string): SanitizedLiveCaseVerdict {
  return {
    caseId,
    status: "failed",
    actionMatches: false,
    seamMatches: false,
    unsafeAction: false,
    textPassed: false,
    voicePassed: false,
    channelConsistent: false,
    errorCode
  };
}

class LiveEvaluationTimeoutError extends Error {}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LiveEvaluationTimeoutError("live_case_timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
import { createHash } from "node:crypto";
