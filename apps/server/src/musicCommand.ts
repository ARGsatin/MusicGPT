import type {
  ListeningConstraint,
  LearningReceipt,
  MusicActionPlan,
  MusicActionStep,
  MusicCommandActionResult,
  MusicCommandRequest,
  MusicCommandResult,
  NowPlayingState,
  RadioPlanItem,
  Track,
  TrackReference
} from "@musicgpt/shared";

import type { AiDjIntent } from "./aiDjAssistant.js";
import { getTrackKey, normalizeTrackReference } from "./musicCatalog.js";
import { StateRepository } from "./stateRepository.js";
import { satisfiesListeningConstraints } from "./listeningPolicy.js";

const CONFIRMATION_TTL_MS = 120_000;

export interface MusicCommandRuntime {
  getNow(): NowPlayingState;
  plan?(request: string): Promise<MusicActionPlan>;
  classify(request: string): Promise<AiDjIntent>;
  searchSongs(query: string): Promise<Track[]>;
  resolveTrack?(trackId: TrackReference): Track | undefined;
  playTrack(track: Track, reason: string, planItem?: RadioPlanItem): Promise<NowPlayingState>;
  setFavorite(trackId: TrackReference, favorite: boolean): Promise<LearningReceipt | void>;
  replay(trackId: TrackReference): Promise<void>;
  handleIntent(
    request: string,
    intent: AiDjIntent,
    mode: MusicCommandRequest["mode"],
    constraints?: ListeningConstraint[]
  ): Promise<MusicCommandResult>;
  handleAction?(
    request: string,
    action: MusicActionStep,
    constraints: ListeningConstraint[],
    mode: MusicCommandRequest["mode"]
  ): Promise<MusicCommandResult>;
}

export class MusicCommandModule {
  private readonly inFlight = new Map<string, Promise<MusicCommandResult>>();
  private readonly pendingConfirmationPlans = new Map<string, MusicActionPlan>();

  constructor(
    private readonly repo: StateRepository,
    private readonly runtime?: MusicCommandRuntime
  ) {}

  async execute(
    request: MusicCommandRequest,
    run?: (confirmedTrack?: Track) => Promise<MusicCommandResult>,
    preplanned?: MusicActionPlan
  ): Promise<MusicCommandResult> {
    const executionKey = scopedCommandId(request);
    const cached = this.repo.getConversationToolCall(executionKey) ??
      matchingLegacyCall(this.repo.getConversationToolCall(request.commandId), request.turnId);
    if (cached) return withActionResults(cached.result as MusicCommandResult);
    const pending = this.inFlight.get(executionKey);
    if (pending) return pending;

    const execution = this.executeFresh(request, executionKey, run, preplanned);
    this.inFlight.set(executionKey, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(executionKey);
    }
  }

  private async executeFresh(
    request: MusicCommandRequest,
    executionKey: string,
    run?: (confirmedTrack?: Track) => Promise<MusicCommandResult>,
    preplanned?: MusicActionPlan
  ): Promise<MusicCommandResult> {
    let confirmedTrack: Track | undefined;
    let confirmedRequest: MusicCommandRequest | undefined;
    let confirmedPlan: MusicActionPlan | undefined;
    if (request.confirmationToken) {
      const confirmation = this.repo.getConversationToolCall(request.confirmationToken);
      const result = confirmation?.result as MusicCommandResult | undefined;
      const createdAt = confirmation ? Date.parse(confirmation.createdAt) : Number.NaN;
      confirmedTrack = result?.candidates?.find(
        (track) =>
          request.selectedTrackId !== undefined &&
          getTrackKey(track) === normalizeTrackReference(request.selectedTrackId)
      );
      if (
        !confirmation ||
        confirmation.consumedAt ||
        !Number.isFinite(createdAt) ||
        Date.now() - createdAt > CONFIRMATION_TTL_MS ||
        result?.outcome !== "needs_confirmation" ||
        !confirmedTrack
      ) {
        return withActionResults(invalidConfirmation(result?.now, "这次点歌确认已经失效，请重新说一次。"));
      }
      if (!this.repo.consumeConversationToolCall(request.confirmationToken)) {
        return withActionResults(invalidConfirmation(result?.now, "这次点歌确认已经使用过了，请重新说一次。"));
      }
      const pending = pendingConfirmationFromUnknown(confirmation.request);
      confirmedRequest = pending?.request;
      confirmedPlan = pending?.plan;
    }

    const result = withActionResults(run
      ? await run(confirmedTrack)
      : await this.executeDomain(request, confirmedTrack, executionKey, confirmedRequest, confirmedPlan, preplanned));
    const pendingPlan = this.pendingConfirmationPlans.get(executionKey);
    this.pendingConfirmationPlans.delete(executionKey);
    this.repo.saveConversationToolCall({
      commandId: executionKey,
      turnId: request.turnId,
      toolName: "run_music_command",
      request: pendingPlan ? { request, plan: pendingPlan } : request,
      result,
      createdAt: new Date().toISOString()
    });
    if (result.outcome !== "needs_confirmation") {
      this.repo.saveConversationToolCall({
        commandId: request.commandId,
        turnId: request.turnId,
        toolName: "run_music_command",
        request,
        result,
        createdAt: new Date().toISOString()
      });
    }
    return result;
  }

  private async executeDomain(
    request: MusicCommandRequest,
    confirmedTrack?: Track,
    executionKey = scopedCommandId(request),
    confirmedRequest?: MusicCommandRequest,
    confirmedPlan?: MusicActionPlan,
    preplanned?: MusicActionPlan
  ): Promise<MusicCommandResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("music_command_runtime_unavailable");
    if (confirmedTrack) {
      if (confirmedRequest && confirmedPlan) {
        return this.executePlan(
          {
            ...confirmedRequest,
            turnId: request.turnId,
            commandId: request.commandId,
            mode: request.mode
          },
          confirmedPlan,
          confirmedTrack
        );
      }
      const now = await runtime.playTrack(confirmedTrack, "语音确认点歌");
      return executedTrack(confirmedTrack, now);
    }

    const text = request.request.trim();
    const now = runtime.getNow();
    const current = now.track;
    const compound = isCompoundRequest(text);
    if (isSafetyNoop(text)) {
      return {
        action: "noop",
        outcome: "answered",
        summary: "好，这次只聊天，不执行音乐操作。",
        now
      };
    }
    if (!current && refersToCurrentTrackCorrection(text)) {
      const clarification = { question: "当前没有歌曲在播放，你想换掉哪首歌或哪个版本？" };
      return {
        action: "noop",
        outcome: "needs_confirmation",
        summary: clarification.question,
        now,
        clarification
      };
    }
    if (!compound && /队列|接下来|后面.*(?:歌|曲)/u.test(text) && /什么|哪些|看看|告诉/u.test(text)) {
      const titles = now.queue.slice(0, 5).map((item) => `《${item.track.title}》`).join("、");
      return {
        action: "query_queue",
        outcome: "answered",
        summary: titles ? `接下来是 ${titles}。` : "当前播放队列还是空的。",
        now
      };
    }
    if (!compound && /当前|这首|现在/u.test(text) && /什么歌|哪首|歌名|谁唱/u.test(text)) {
      return {
        action: "query_current",
        outcome: "answered",
        summary: current ? `现在是《${current.title}》— ${formatArtists(current)}。` : "当前没有歌曲在播放。",
        now
      };
    }
    if (!compound && /^(?:我)?不喜欢(?:当前|现在)?这首[。！!]?$/u.test(text) && current) {
      return this.executeActionStep(
        request,
        {
          action: "unlike",
          reference: { kind: "current" },
          feedbackReason: "dislike_track",
          scope: "long_term",
          confidence: 1
        },
        getTrackKey(current)
      );
    }
    if (!compound && /^取消(?:这首)?收藏(?:这首)?[。！!]?$/u.test(text) && current) {
      const learningReceipt = await runtime.setFavorite(getTrackKey(current), false);
      return {
        action: "unlike",
        outcome: "executed",
        summary: "已取消收藏这首歌。",
        now: runtime.getNow(),
        ...(learningReceipt ? { learningReceipt } : {})
      };
    }
    if (!compound && /^(?:收藏(?:当前|现在|正在播放的)?这首|喜欢这首|标记喜欢)[。！!]?$/u.test(text) && current) {
      const learningReceipt = await runtime.setFavorite(getTrackKey(current), true);
      return {
        action: "like",
        outcome: "executed",
        summary: "已收藏这首歌。",
        now: runtime.getNow(),
        ...(learningReceipt ? { learningReceipt } : {})
      };
    }
    if (!compound && /^(?:重播(?:这首|当前这首)?|再放一遍|从头(?:播放|播)?)[。！!]?$/u.test(text) && current) {
      await runtime.replay(getTrackKey(current));
      return { action: "replay", outcome: "executed", summary: "已从头重播。", now: runtime.getNow() };
    }
    const exactTrackKey = parseExactTrackKeyRequest(text);
    if (exactTrackKey) {
      const target = runtime.resolveTrack?.(exactTrackKey);
      if (!target) {
        const clarification = { question: "我找不到这个精确曲目编号，请从当前队列重新选择。" };
        return {
          action: "noop",
          outcome: "needs_confirmation",
          summary: clarification.question,
          now: runtime.getNow(),
          clarification
        };
      }
      return executedTrack(
        target,
        await runtime.playTrack(target, request.mode === "voice_direct" ? "语音点歌" : "文字点歌")
      );
    }
    if (isCertainUndoLearningRequest(text)) {
      return this.executePlan(request, {
        actions: [{
          action: "update_long_term_preference",
          description: text,
          scope: "long_term",
          confidence: 1
        }],
        constraints: [],
        references: [],
        confidence: 1
      });
    }

    let structuredPlan = preplanned;
    if (!structuredPlan && runtime.plan) {
      try {
        structuredPlan = await runtime.plan(text);
      } catch {
        structuredPlan = undefined;
      }
    }
    if (structuredPlan) {
      const plan: MusicActionPlan = {
        ...structuredPlan,
        constraints: mergeExplicitSafetyConstraints(text, structuredPlan.constraints)
      };
      if (
        plan.clarification ||
        plan.confidence < 0.75 ||
        (/必须|只要/u.test(text) &&
          plan.actions.some((step) => ["skip", "play_specific", "play_by_description", "play_atmosphere"].includes(step.action)) &&
          !plan.constraints.some((constraint) => constraint.hard)) ||
        plan.actions.some((action) => action.confidence !== undefined && action.confidence < 0.75)
      ) {
        const clarification = plan.clarification ?? {
          question: "我还不太确定你的意思，确认一下你想让我执行什么音乐操作？"
        };
        return {
          action: "noop",
          outcome: "needs_confirmation",
          summary: clarification.question,
          now: runtime.getNow(),
          clarification
        };
      }
      return this.executePlan(request, plan);
    }

    if (compound) {
      const actions: MusicActionStep[] = [];
      for (const clause of splitCompoundRequest(text)) {
        const intent = await runtime.classify(clause);
        const step = intentToActionStep(intent);
        if (!step) {
          const clarification = {
            question: `“${clause}”这一步我还不确定，能再说具体一点吗？`
          };
          return {
            action: "noop",
            outcome: "needs_confirmation",
            summary: clarification.question,
            now: runtime.getNow(),
            clarification
          };
        }
        actions.push(step);
      }
      return this.executePlan(request, {
        actions,
        constraints: [],
        references: actions.flatMap((action) => action.reference ? [action.reference] : []),
        confidence: 0.9
      });
    }

    const intent = await runtime.classify(text);
    if (intent.type !== "play_specific") {
      const step = intentToActionStep(intent);
      if (step) {
        return this.completeSuggestedPlayback(
          await this.executeActionStep(request, step, undefined, undefined, [])
        );
      }
      return this.completeSuggestedPlayback(
        await runtime.handleIntent(text, intent, request.mode)
      );
    }

    const query = intent.searchQuery?.trim() || intent.query.trim();
    const matches = await runtime.searchSongs(query);
    if (matches.length === 0) {
      return { action: "play_specific", outcome: "failed", summary: `没有搜到《${query}》。`, now: runtime.getNow() };
    }
    const candidates = matches.slice(0, 3);
    if (!isConfidentVoiceMatch(query, candidates)) {
      return {
        action: "play_specific",
        outcome: "needs_confirmation",
        summary: `我找到了 ${candidates.map((track) => `《${track.title}》`).join("、")}，你想听哪一首？`,
        now: runtime.getNow(),
        candidates,
        confirmationToken: executionKey
      };
    }
    const target = candidates[0]!;
    const next = await runtime.playTrack(target, "语音点歌");
    return executedTrack(target, next);
  }

  private async executePlan(
    request: MusicCommandRequest,
    plan: MusicActionPlan,
    confirmedTrack?: Track
  ): Promise<MusicCommandResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("music_command_runtime_unavailable");
    const actions: MusicCommandActionResult[] = [];
    const references = new Map<number, TrackReference>();
    const selectedTracks = new Map<number, Track>();
    let confirmedSelectionAvailable = Boolean(confirmedTrack);
    const nowBeforeExecution = runtime.getNow();

    // Resolve every reference before any action is allowed to run. In
    // particular, a relative play request is a lookup into listening history,
    // not a fuzzy catalog search for the words "刚才第二首".
    for (const [index, step] of plan.actions.entries()) {
      const reference = step.reference ?? (step.feedbackReason ? { kind: "current" as const } : undefined);
      if (!reference) continue;
      if (reference.kind === "current" && plan.actions.slice(0, index).some((prior) => prior.action === "play_specific")) continue;
      const resolved = this.resolveReference(reference, nowBeforeExecution);
      const resolvedTrack = resolved !== undefined && step.action === "play_specific"
        ? this.resolveTrack(reference, resolved, nowBeforeExecution)
        : undefined;
      if (resolved === undefined || (step.action === "play_specific" && !resolvedTrack)) {
        const clarification = {
          question: referenceClarification(reference)
        };
        this.pendingConfirmationPlans.set(scopedCommandId(request), plan);
        return {
          action: "noop",
          outcome: "needs_confirmation",
          summary: clarification.question,
          now: nowBeforeExecution,
          clarification,
          actions
        };
      }
      references.set(index, resolved);
      if (resolvedTrack) selectedTracks.set(index, resolvedTrack);
    }

    for (const [index, step] of plan.actions.entries()) {
      if (step.action !== "play_specific" || selectedTracks.has(index)) continue;
      if (confirmedTrack && confirmedSelectionAvailable) {
        selectedTracks.set(index, confirmedTrack);
        confirmedSelectionAvailable = false;
        continue;
      }
      const query = step.searchQuery?.trim() || step.query?.trim();
      if (!query) {
        return {
          action: "play_specific",
          outcome: "failed",
          summary: "点歌请求里没有可搜索的歌名或艺人。",
          now: nowBeforeExecution,
          actions
        };
      }
      const matches = (await runtime.searchSongs(query)).filter((track) => satisfiesListeningConstraints(track, plan.constraints));
      if (matches.length === 0) {
        return {
          action: "play_specific",
          outcome: "failed",
          summary: `没有搜到《${query}》。`,
          now: nowBeforeExecution,
          actions
        };
      }
      const candidates = matches.slice(0, 3);
      if (!isConfidentVoiceMatch(query, candidates)) {
        const clarification = {
          question: `我找到了 ${candidates.map((track) => `《${track.title}》— ${formatArtists(track)}`).join("、")}，你想听哪一首？`,
          candidates
        };
        this.pendingConfirmationPlans.set(scopedCommandId(request), plan);
        return {
          action: "play_specific",
          outcome: "needs_confirmation",
          summary: clarification.question,
          now: nowBeforeExecution,
          candidates,
          confirmationToken: scopedCommandId(request),
          clarification,
          actions
        };
      }
      selectedTracks.set(index, candidates[0]!);
    }
    let projectedTrack: Track | undefined;
    for (const [index, step] of plan.actions.entries()) {
      if (step.reference?.kind === "current" && projectedTrack) {
        references.set(index, getTrackKey(projectedTrack));
        if (step.action === "play_specific") selectedTracks.set(index, projectedTrack);
      }
      if (step.action === "play_specific") projectedTrack = selectedTracks.get(index);
    }
    if ([...selectedTracks.values()].some((track) => !satisfiesListeningConstraints(track, plan.constraints))) {
      const clarification = { question: "这首歌无法确认满足你刚才的限制，要放宽条件吗？" };
      return { action: "noop", outcome: "needs_confirmation", summary: clarification.question, clarification, now: nowBeforeExecution, actions };
    }
    let last: MusicCommandResult | undefined;
    let lastLearningReceipt: LearningReceipt | undefined;
    for (const [index, step] of plan.actions.entries()) {
      let result: MusicCommandResult;
      try {
        result = await this.executeActionStep(
          request,
          references.has(index) ? { ...step, reference: { kind: "track", trackId: references.get(index)! } } : step,
          references.get(index), selectedTracks.get(index), plan.constraints
        );
      } catch {
        result = {
          action: step.action,
          outcome: "failed",
          summary: `第 ${index + 1} 步执行失败，已完成的操作已保留。`,
          now: runtime.getNow()
        };
      }
      actions.push({
        index,
        action: result.action,
        outcome: result.outcome,
        summary: result.summary,
        now: result.now,
        ...(result.learningReceipt ? { learningReceipt: result.learningReceipt } : {})
      });
      if (result.learningReceipt) lastLearningReceipt = result.learningReceipt;
      last = result;
      if (result.outcome === "failed" || result.outcome === "needs_confirmation") break;
    }
    if (!last) {
      return {
        action: "noop",
        outcome: "failed",
        summary: "没有可执行的音乐操作。",
        now: runtime.getNow(),
        actions
      };
    }
    return {
      ...last,
      summary: actions.map((action) => action.summary).join(" "),
      actions,
      ...(lastLearningReceipt ? { learningReceipt: lastLearningReceipt } : {})
    };
  }

  private async executeActionStep(
    request: MusicCommandRequest,
    step: MusicActionStep,
    reference?: TrackReference,
    selectedTrack?: Track,
    constraints: ListeningConstraint[] = []
  ): Promise<MusicCommandResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("music_command_runtime_unavailable");
    switch (step.action) {
      case "like":
      case "unlike": {
        if (runtime.handleAction && (step.feedbackReason || step.scope)) {
          return runtime.handleAction(request.request, step, constraints, request.mode);
        }
        if (reference === undefined) return missingReference(runtime.getNow());
        const favorite = step.action === "like";
        const learningReceipt = await runtime.setFavorite(reference, favorite);
        return {
          action: step.action,
          outcome: "executed",
          summary: favorite ? "已收藏这首歌。" : "已取消收藏这首歌。",
          now: runtime.getNow(),
          ...(learningReceipt ? { learningReceipt } : {})
        };
      }
      case "replay":
        if (reference === undefined) return missingReference(runtime.getNow());
        await runtime.replay(reference);
        return {
          action: "replay",
          outcome: "executed",
          summary: "已从头重播。",
          now: runtime.getNow()
        };
      case "play_specific":
        if (!selectedTrack) {
          return {
            action: "play_specific",
            outcome: "failed",
            summary: "没有找到可以播放的候选歌曲。",
            now: runtime.getNow()
          };
        }
        return executedTrack(
          selectedTrack,
          await runtime.playTrack(selectedTrack, request.mode === "voice_direct" ? "语音点歌" : "文字点歌")
        );
      case "query_current": {
        const now = runtime.getNow();
        return {
          action: "query_current",
          outcome: "answered",
          summary: now.track
            ? `现在是《${now.track.title}》— ${formatArtists(now.track)}。`
            : "当前没有歌曲在播放。",
          now
        };
      }
      case "query_queue": {
        const now = runtime.getNow();
        const titles = now.queue.slice(0, 5).map((item) => `《${item.track.title}》`).join("、");
        return {
          action: "query_queue",
          outcome: "answered",
          summary: titles ? `接下来是 ${titles}。` : "当前播放队列还是空的。",
          now
        };
      }
      case "update_session_intent":
      case "update_long_term_preference":
        return runtime.handleAction
          ? runtime.handleAction(request.request, step, constraints, request.mode)
          : {
              action: step.action,
              outcome: "failed",
              summary: "当前还不能保存这项音乐偏好。",
              now: runtime.getNow()
            };
      case "replan":
        if (runtime.handleAction) {
          return runtime.handleAction(request.request, step, constraints, request.mode);
        }
        return step.desiredMood
          ? runtime.handleIntent(
              request.request,
              { type: "replan", desiredMood: step.desiredMood },
              request.mode
            )
          : {
              action: "replan",
              outcome: "failed",
              summary: "没有识别出要切换的音乐风格。",
              now: runtime.getNow()
            };
      default: {
        const intent = actionStepToIntent(step);
        return intent
          ? this.completeSuggestedPlayback(
              await runtime.handleIntent(request.request, intent, request.mode, constraints)
            )
          : {
              action: step.action,
              outcome: "failed",
              summary: "这个音乐操作暂时还不能执行。",
              now: runtime.getNow()
            };
      }
    }
  }

  private async completeSuggestedPlayback(
    result: MusicCommandResult
  ): Promise<MusicCommandResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("music_command_runtime_unavailable");
    const suggestion = result.suggestion;
    if (
      !suggestion ||
      (result.action !== "play_specific" &&
        result.action !== "play_by_description" &&
        result.action !== "play_atmosphere")
    ) {
      return result;
    }
    const now = await runtime.playTrack(suggestion.track, suggestion.reason, suggestion.planItem);
    const { suggestion: _suggestion, ...withoutSuggestion } = result;
    return {
      ...withoutSuggestion,
      outcome: "executed",
      summary: result.action === "play_specific"
        ? `已切到《${suggestion.track.title}》— ${formatArtists(suggestion.track)}。`
        : `${suggestion.reason}，已切到《${suggestion.track.title}》— ${formatArtists(suggestion.track)}。`,
      now
    };
  }

  private resolveReference(
    reference: MusicActionStep["reference"],
    now: NowPlayingState
  ): TrackReference | undefined {
    if (!reference) return undefined;
    switch (reference.kind) {
      case "current":
        return now.track ? getTrackKey(now.track) : undefined;
      case "queue":
        return now.queue[(reference.index ?? 1) - 1]?.track
          ? getTrackKey(now.queue[(reference.index ?? 1) - 1]!.track)
          : undefined;
      case "recent": {
        const distinct = [...new Set(
          this.repo.getRecentPlayEvents(120)
            .filter((event) => event.type === "play_start" || event.type === "play")
            .map((event) => normalizeTrackReference(event.trackId))
        )];
        return distinct[(reference.index ?? 1) - 1];
      }
      case "track":
        return reference.trackId;
    }
  }

  private resolveTrack(
    reference: NonNullable<MusicActionStep["reference"]>,
    trackId: TrackReference,
    now: NowPlayingState
  ): Track | undefined {
    const resolved = this.runtime?.resolveTrack?.(trackId);
    if (resolved) return resolved;
    if (reference.kind === "current") return now.track;
    if (reference.kind === "queue") return now.queue[(reference.index ?? 1) - 1]?.track;
    return undefined;
  }
}

function scopedCommandId(request: Pick<MusicCommandRequest, "turnId" | "commandId">): string {
  return JSON.stringify([request.turnId, request.commandId]);
}

function withActionResults(result: MusicCommandResult): MusicCommandResult {
  if (result.actions && result.actions.length > 0) return result;
  return {
    ...result,
    actions: [{
      index: 0,
      action: result.action,
      outcome: result.outcome,
      summary: result.summary,
      now: result.now,
      ...(result.learningReceipt ? { learningReceipt: result.learningReceipt } : {})
    }]
  };
}

function matchingLegacyCall<T extends { turnId: string }>(call: T | undefined, turnId: string): T | undefined {
  return call?.turnId === turnId ? call : undefined;
}

function musicCommandRequestFromUnknown(value: unknown): MusicCommandRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Partial<MusicCommandRequest>;
  if (
    typeof request.turnId !== "string" ||
    typeof request.commandId !== "string" ||
    typeof request.request !== "string" ||
    (request.mode !== "text_suggest" && request.mode !== "voice_direct")
  ) {
    return undefined;
  }
  return request as MusicCommandRequest;
}

function pendingConfirmationFromUnknown(value: unknown): {
  request: MusicCommandRequest;
  plan?: MusicActionPlan;
} | undefined {
  const direct = musicCommandRequestFromUnknown(value);
  if (direct) return { request: direct };
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as { request?: unknown; plan?: unknown };
  const request = musicCommandRequestFromUnknown(envelope.request);
  if (!request) return undefined;
  const candidate = envelope.plan as Partial<MusicActionPlan> | undefined;
  const plan = candidate &&
    Array.isArray(candidate.actions) &&
    Array.isArray(candidate.constraints) &&
    Array.isArray(candidate.references) &&
    typeof candidate.confidence === "number"
      ? candidate as MusicActionPlan
      : undefined;
  return { request, ...(plan ? { plan } : {}) };
}

function isCompoundRequest(text: string): boolean {
  return /然后|并且|接着|(?:，|,).*(?:再|然后|换|切|播|放|收藏|暂停|继续)|(?:后|之后)\s*(?:再|换|切|播|放|收藏|暂停|继续)/u.test(
    text
  );
}

function isSafetyNoop(text: string): boolean {
  if (/只聊天|随便聊|先聊天|只聊聊/u.test(text)) return true;
  if (/^(?:请\s*)?(?:先\s*)?(?:别|不要)(?:点歌|播|播放|放歌)(?:了|任何东西)?[。！!]?$/u.test(text)) {
    return true;
  }
  return /(?:别|不要|不用)(?:再)?(?:收藏|重播|再放一遍|从头播|跳过|暂停|继续|切歌|换歌)/u.test(text);
}

function refersToCurrentTrackCorrection(text: string): boolean {
  return /(?:这首|当前(?:这首)?|这个版本).*(?:不喜欢|不合适|听腻|腻了|版本|换一个|换掉|少放)/u.test(text);
}

function isCertainUndoLearningRequest(text: string): boolean {
  return /^(?:请)?(?:帮我)?撤销(?:掉)?(?:刚才|上一条|上次)(?:那条|这条)?(?:学习|偏好|反馈)(?:记录)?[。！!]?$/u.test(text);
}

function parseExactTrackKeyRequest(text: string): TrackReference | undefined {
  const match = /^(?:请)?(?:播放|播|放)\s*((?:ncm|qq):[^\s。！!]+)[。！!]?$/iu.exec(text);
  return match?.[1] ? normalizeTrackReference(match[1]) : undefined;
}

function mergeExplicitSafetyConstraints(
  text: string,
  constraints: ListeningConstraint[]
): ListeningConstraint[] {
  if (!/(?:不要|别|避免)(?:再)?(?:播(?:放)?|放|来)?\s*(?:纯器乐|纯音乐|器乐)/u.test(text)) {
    return constraints;
  }
  const isInstrumentalAvoid = (constraint: ListeningConstraint) =>
    constraint.kind === "avoid" && /^(?:器乐|纯器乐|纯音乐|instrumental)$/iu.test(constraint.value.trim());
  return [
    ...constraints.filter((constraint) => !isInstrumentalAvoid(constraint)),
    { kind: "avoid", value: "器乐", scope: "session", hard: true }
  ];
}

function splitCompoundRequest(text: string): string[] {
  return text
    .split(/\s*(?:然后|并且|接着)\s*|\s*后(?=(?:再|换|切|播|放|收藏|暂停|继续))\s*/u)
    .map((part) => part.replace(/^[，,]\s*/u, "").trim())
    .filter(Boolean);
}

function missingReference(now: NowPlayingState): MusicCommandResult {
  return {
    action: "noop",
    outcome: "failed",
    summary: "没有找到你指的那首歌。",
    now
  };
}

function referenceClarification(reference: NonNullable<MusicActionStep["reference"]>): string {
  if (reference.kind === "recent") {
    return `我没找到刚才第 ${reference.index ?? 1} 首，能说一下歌名吗？`;
  }
  if (reference.kind === "queue") {
    return `后面的第 ${reference.index ?? 1} 首还不存在，要不要换个说法？`;
  }
  return "我没找到你指的那首歌，能说一下歌名吗？";
}

function invalidConfirmation(now: NowPlayingState | undefined, summary: string): MusicCommandResult {
  return { action: "noop", outcome: "failed", summary, now: now ?? { queue: [], paused: false } };
}

function executedTrack(track: Track, now: NowPlayingState): MusicCommandResult {
  return {
    action: "play_specific",
    outcome: "executed",
    summary: `已切到《${track.title}》— ${formatArtists(track)}。`,
    now
  };
}

function isConfidentVoiceMatch(query: string, candidates: Track[]): boolean {
  const normalized = normalizeMatchText(query);
  if (!normalized || candidates.length <= 1) return candidates.length > 0;
  const first = candidates[0];
  if (!first) return false;
  const exactTitle = normalizeMatchText(first.title) === normalized;
  const exactTitleMatches = candidates.filter(
    (track) => normalizeMatchText(track.title) === normalized
  ).length;
  const artistMatch = first.artists.some((artist) => {
    const normalizedArtist = normalizeMatchText(artist);
    return normalizedArtist === normalized || normalized.includes(normalizedArtist);
  });
  const allSameArtist = candidates.every((track) =>
    track.artists.some((artist) => normalizeMatchText(artist) === normalized)
  );
  return (exactTitle && exactTitleMatches === 1) || artistMatch || allSameArtist;
}

function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/[\s《》「」“”"'·,，。.!！?？-]/gu, "");
}

function formatArtists(track: Track): string {
  return track.artists.length > 0 ? track.artists.join(" / ") : "未知艺术家";
}

function actionStepToIntent(step: MusicActionStep): AiDjIntent | undefined {
  switch (step.action) {
    case "skip":
    case "pause":
    case "resume":
    case "comment_current":
    case "play_atmosphere":
      return { type: step.action };
    case "replan":
      return step.desiredMood ? { type: "replan", desiredMood: step.desiredMood } : undefined;
    case "play_specific": {
      const query = step.query?.trim() || step.searchQuery?.trim();
      return query ? { type: "play_specific", query, searchQuery: step.searchQuery } : undefined;
    }
    case "play_by_description": {
      const description = step.description?.trim();
      return description
        ? { type: "play_by_description", description, searchQuery: step.searchQuery }
        : undefined;
    }
    case "noop":
      return { type: "chat" };
    default:
      return undefined;
  }
}

function intentToActionStep(intent: AiDjIntent): MusicActionStep | undefined {
  switch (intent.type) {
    case "chat":
      return undefined;
    case "replan":
      return { action: "replan", desiredMood: intent.desiredMood, confidence: 0.9 };
    case "play_specific":
      return {
        action: "play_specific",
        query: intent.query,
        ...(intent.searchQuery ? { searchQuery: intent.searchQuery } : {}),
        confidence: 0.9
      };
    case "play_by_description":
      return {
        action: "play_by_description",
        description: intent.description,
        ...(intent.searchQuery ? { searchQuery: intent.searchQuery } : {}),
        confidence: 0.9
      };
    default:
      return { action: intent.type, confidence: 0.9 };
  }
}
