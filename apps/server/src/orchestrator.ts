import { createExtensionProviders } from "./providers.js";

import type {
  ChatResponse,
  DjSettings,
  EnvironmentContext,
  EnvironmentLocationRequest,
  FeedbackRequest,
  ImportNcmResponse,
  RecommendationImportResponse,
  NowPlayingState,
  NcmImportErrorCode,
  PlayEvent,
  RadioPlanItem,
  SystemStatus,
  TasteProfile,
  Track,
  TrackLyrics,
  TrackSuggestion
} from "@musicgpt/shared";
import type { AiDjAssistant, AiDjContext, AiDjIntent, TrackSelection } from "./aiDjAssistant.js";
import { fallbackChatReply, fallbackClassify, fallbackComment } from "./aiDjAssistant.js";
import { DjBrain } from "./djBrain.js";
import { EnvironmentService } from "./environmentService.js";
import { NcmConnector, NcmImportError } from "./ncmConnector.js";
import { RadioPlanner } from "./radioPlanner.js";
import { RecommendationImporter } from "./recommendationImporter.js";
import { StateRepository } from "./stateRepository.js";
import { SpeechTextSegmenter } from "./speechSegmenter.js";
import { TasteEngine } from "./tasteEngine.js";
import { prepareSpeechText, TtsPipeline } from "./ttsPipeline.js";
import { WsHub } from "./wsHub.js";

const PLAN_WINDOW_SIZE = 10;
const QUEUE_TARGET_SIZE = 10;
const QUEUE_REFILL_THRESHOLD = 6;
const IMPORT_RETRY_INTERVAL_MS = 60_000;
export const DEFAULT_DJ_SETTINGS: DjSettings = {
  tone: "lively",
  voiceGender: "female",
  voice: "zh-CN-XiaoxiaoNeural"
};

type EnvironmentRuntime = Pick<EnvironmentService, "getContext" | "updateLocation">;

export interface ChatStreamCallbacks {
  synthesizeSpeech: boolean;
  onTextDelta(delta: string): void;
  onSpeech(segment: { sequence: number; text: string; audioUrl: string }): void;
  onResult(response: ChatResponse): void;
}

export class RadioOrchestrator {
  private state: NowPlayingState = { queue: [], paused: false };
  private desiredMood?: string;
  private completedTracksSinceLastDj = 0;
  private importRetryTimer: ReturnType<typeof setInterval> | undefined;
  private importInFlight = false;
  private lastImportAt: string | undefined;
  private lastImportError: string | undefined;
  private lastImportErrorCode: NcmImportErrorCode | undefined;

  constructor(
    private readonly repo: StateRepository,
    private readonly ncm: NcmConnector,
    private readonly tasteEngine: TasteEngine,
    private readonly planner: RadioPlanner,
    private readonly djBrain: DjBrain,
    private readonly aiDjAssistant: AiDjAssistant,
    private readonly ttsPipeline: TtsPipeline,
    private readonly wsHub: WsHub,
    private readonly djBroadcastInterval: number,
    private readonly memoryTurns: number,
    private readonly importRetryIntervalMs: number = IMPORT_RETRY_INTERVAL_MS,
    private readonly environmentService: EnvironmentRuntime = new EnvironmentService(),
    private readonly recommendationImporter: RecommendationImporter = new RecommendationImporter(repo, ncm)
  ) {}

  async initialize(): Promise<void> {
    this.state = this.repo.getNowPlaying() ?? { queue: [], paused: false };
    this.ensureDjSettings();
    if (this.repo.getTrackStatsCount() === 0) {
      await this.runNcmImport();
    }
    await this.refreshTasteProfile();
    if (this.state.track && this.state.lyrics?.trackId !== this.state.track.id) {
      this.state.lyrics = await this.ncm.fetchLyrics(this.state.track.id);
      this.repo.saveNowPlaying(this.state);
    }
    await this.ensureQueue();
    if (!this.state.track && this.state.queue.length > 0) {
      await this.nextTrack();
    }
    this.startImportRetryLoop();

    for (const provider of createExtensionProviders()) {
      await provider.refresh().catch(() => undefined);
    }
    await this.broadcastSystemStatus();
  }

  close(): void {
    this.stopImportRetryLoop();
  }

  async importFromNcm(): Promise<number> {
    return this.runNcmImport();
  }

  async importFromNcmAndRefresh(): Promise<ImportNcmResponse> {
    const importedCount = await this.runNcmImport();
    if (importedCount > 0) {
      await this.postImportRefresh();
      this.stopImportRetryLoop();
    } else {
      this.startImportRetryLoop();
    }
    await this.broadcastSystemStatus();
    const systemStatus = await this.getSystemStatus();
    if (importedCount > 0) {
      return { ok: true, importedCount, systemStatus };
    }
    return {
      ok: false,
      importedCount,
      error: this.lastImportError ?? "网易云导入失败。",
      ...(this.lastImportErrorCode ? { errorCode: this.lastImportErrorCode } : {}),
      systemStatus
    };
  }

  getNow(): NowPlayingState {
    return this.state;
  }

  getTaste(): TasteProfile | undefined {
    return this.repo.getTasteProfile();
  }

  getEnvironment(): EnvironmentContext {
    return this.repo.getEnvironmentContext() ?? this.environmentService.getContext();
  }

  async updateEnvironmentLocation(location: EnvironmentLocationRequest): Promise<EnvironmentContext> {
    const context = await this.environmentService.updateLocation(location);
    this.repo.saveEnvironmentContext(context);
    await this.ensureQueue();
    await this.broadcastSystemStatus();
    return context;
  }

  getDjSettings(): DjSettings {
    return this.repo.getDjSettings() ?? DEFAULT_DJ_SETTINGS;
  }

  async updateDjSettings(settings: DjSettings): Promise<DjSettings> {
    const normalized: DjSettings = {
      tone: settings.tone,
      voiceGender: settings.voiceGender,
      voice: settings.voice.trim() || DEFAULT_DJ_SETTINGS.voice
    };
    this.repo.saveDjSettings(normalized);
    this.ttsPipeline.setVoice(normalized.voice);
    await this.broadcastSystemStatus();
    return normalized;
  }

  getChatHistory(): { messages: ChatResponse["messages"] } {
    return { messages: this.repo.getRecentMessages(this.chatHistoryLimit()) };
  }

  async synthesizeChatMessage(messageId: number): Promise<
    | { status: "ok"; messageId: number; audioUrl: string }
    | { status: "not_found" | "not_assistant" | "unavailable" }
  > {
    const message = this.repo.getChatMessage(messageId);
    if (!message) {
      return { status: "not_found" };
    }
    if (message.role !== "assistant") {
      return { status: "not_assistant" };
    }
    const speech = await this.ttsPipeline.synthesizeText(message.text);
    if (!speech.audioUrl) {
      return { status: "unavailable" };
    }
    this.repo.saveChatSpeech(messageId, {
      audioUrl: speech.audioUrl,
      profileKey: speech.profileKey
    });
    return {
      status: "ok",
      messageId,
      audioUrl: speech.audioUrl
    };
  }

  clearChatHistory(): { ok: true; messages: [] } {
    this.repo.clearChatMessages();
    return { ok: true, messages: [] };
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const aiDjStatus = this.aiDjAssistant.status();
    const status: SystemStatus = {
      runningRoot: process.cwd(),
      ncmReachable: await this.ncm.isReachable(),
      aiDjConfigured: aiDjStatus.configured,
      aiDjProvider: aiDjStatus.provider,
      trackStatsCount: this.repo.getTrackStatsCount(),
      queueLength: this.state.queue.length
    };
    if (aiDjStatus.model) {
      status.aiDjModel = aiDjStatus.model;
    }
    if (typeof aiDjStatus.baseUrlConfigured === "boolean") {
      status.aiDjBaseUrlConfigured = aiDjStatus.baseUrlConfigured;
    }
    if (aiDjStatus.lastError) {
      status.aiDjLastError = aiDjStatus.lastError;
    }
    if (this.lastImportAt) {
      status.lastImportAt = this.lastImportAt;
    }
    if (this.lastImportError) {
      status.lastImportError = this.lastImportError;
    }
    if (this.lastImportErrorCode) {
      status.lastImportErrorCode = this.lastImportErrorCode;
    }
    status.environment = this.getEnvironment();
    status.djSettings = this.getDjSettings();
    return status;
  }

  async refreshTasteProfile(): Promise<TasteProfile> {
    const profile = this.tasteEngine.generate(
      this.repo.getTrackStats(),
      this.repo.getRecentPlayEvents(200)
    );
    this.repo.saveTasteProfile(profile);
    return profile;
  }

  async ensureQueue(): Promise<void> {
    if (this.state.queue.length >= QUEUE_REFILL_THRESHOLD) {
      return;
    }
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const planOptions = this.desiredMood
      ? { windowSize: PLAN_WINDOW_SIZE, desiredMood: this.desiredMood, environment: this.getEnvironment() }
      : { windowSize: PLAN_WINDOW_SIZE, environment: this.getEnvironment() };
    const planned = this.planner.plan(
      this.repo.getTrackStats(),
      profile,
      this.repo.getRecentPlayEvents(120),
      planOptions
    );
    this.state.queue = dedupeByTrackId([...this.state.queue, ...planned]).slice(0, QUEUE_TARGET_SIZE);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  async nextTrack(forceReplan = false): Promise<NowPlayingState> {
    if (forceReplan) {
      this.state.queue = [];
    }
    await this.ensureQueue();
    const next = this.state.queue.shift();
    if (!next) {
      return this.state;
    }
    const resolved = await this.hydrateTrack(next);
    this.state.track = resolved.item.track;
    this.state.lyrics = resolved.lyrics;
    this.state.startedAt = new Date().toISOString();
    this.state.paused = false;

    await this.ensureQueue();

    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    return this.state;
  }

  async playSuggestedTrack(track: Track, reason?: string): Promise<NowPlayingState> {
    this.state.queue.unshift({
      track,
      score: 0.99,
      reason: reason?.trim() || `Requested from GPT DJ: ${track.title}`
    });
    return this.nextTrack();
  }

  async handleFeedback(feedback: FeedbackRequest): Promise<void> {
    const event: PlayEvent = {
      type: feedback.type,
      trackId: feedback.trackId,
      at: new Date().toISOString()
    };
    this.repo.addPlayEvent(event);
    if (feedback.type === "like") {
      this.repo.markTrackLiked(feedback.trackId, event.at);
    }
    if (feedback.type === "complete") {
      this.completedTracksSinceLastDj += 1;
      await this.maybeGenerateDj();
    }
    if (feedback.type === "replay") {
      this.state.paused = false;
      this.state.startedAt = event.at;
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    await this.refreshTasteProfile();
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  async handleChat(message: string): Promise<ChatResponse> {
    this.repo.addChatMessage({ role: "user", text: message, at: new Date().toISOString() });
    const context = this.buildAiContext();
    const intent = await this.classifySafely(message, context);
    return this.handleChatIntent(message, context, intent);
  }

  async handleChatStream(message: string, callbacks: ChatStreamCallbacks): Promise<ChatResponse> {
    this.repo.addChatMessage({ role: "user", text: message, at: new Date().toISOString() });
    const context = this.buildAiContext();
    const intent = await this.classifySafely(message, context);
    const segmenter = new SpeechTextSegmenter();
    let speechSequence = 0;
    let speechWork = Promise.resolve();

    const queueSpeech = (segments: string[]) => {
      if (!callbacks.synthesizeSpeech) {
        return;
      }
      for (const segment of segments) {
        speechWork = speechWork.then(async () => {
          const speech = await this.ttsPipeline.synthesizeText(segment);
          if (speech.audioUrl) {
            callbacks.onSpeech({
              sequence: speechSequence,
              text: segment,
              audioUrl: speech.audioUrl
            });
            speechSequence += 1;
          }
        }).catch(() => undefined);
      }
    };

    const emitText = (delta: string) => {
      if (!delta) {
        return;
      }
      callbacks.onTextDelta(delta);
      queueSpeech(segmenter.push(delta));
    };

    const streamReply = async (
      stream: AsyncIterable<string>,
      fallback: string,
      action: ChatResponse["action"],
      initialText = "",
      trackSuggestion?: TrackSuggestion
    ): Promise<ChatResponse> => {
      let generatedText = "";
      if (initialText) {
        emitText(initialText);
      }
      try {
        for await (const delta of stream) {
          generatedText += delta;
          emitText(delta);
        }
      } catch (error) {
        if (!generatedText) {
          const notice = aiFallbackNotice(this.aiDjAssistant.status().provider, error, fallback);
          callbacks.onTextDelta(notice);
          queueSpeech(segmenter.push(fallback));
          generatedText = notice;
        }
      }
      if (!generatedText) {
        generatedText = fallback;
        emitText(generatedText);
      }
      queueSpeech(segmenter.finish());
      return this.reply(
        action,
        `${initialText}${generatedText}`,
        this.state,
        trackSuggestion
      );
    };

    let response: ChatResponse;
    const aiConfigured = this.aiDjAssistant.status().configured;
    if (intent.type === "chat" && aiConfigured && this.aiDjAssistant.chatStream) {
      response = await streamReply(
        this.aiDjAssistant.chatStream(message, context),
        fallbackChatReply(message, context),
        "noop"
      );
    } else if (
      intent.type === "comment_current" &&
      this.state.track &&
      aiConfigured &&
      this.aiDjAssistant.commentCurrentStream
    ) {
      response = await streamReply(
        this.aiDjAssistant.commentCurrentStream(context),
        fallbackComment(this.state.track),
        "comment_current"
      );
    } else if (
      intent.type === "play_specific" &&
      aiConfigured &&
      this.aiDjAssistant.commentTrackStream
    ) {
      const query = intent.searchQuery?.trim() || intent.query.trim();
      const target = (await this.ncm.searchSongs(query))[0];
      if (!target) {
        response = this.reply(
          "noop",
          `唔，这次没搜到《${query}》～换个歌名或歌手告诉我，我再帮你找找！`,
          this.state
        );
        callbacks.onTextDelta(response.reply);
        queueSpeech(segmenter.push(response.reply));
        queueSpeech(segmenter.finish());
      } else {
        const purpose = `direct song request: ${query}`;
        const prefix = `我挑了《${target.title}》- ${target.artists.join(" / ")} 给你～想听的话，点一下卡片就好！\n`;
        response = await streamReply(
          this.aiDjAssistant.commentTrackStream(target, context, purpose),
          fallbackComment(target),
          "play_specific",
          prefix,
          this.createTrackSuggestion(target, purpose)
        );
      }
    } else if (
      intent.type === "play_by_description" &&
      aiConfigured &&
      this.aiDjAssistant.commentTrackStream
    ) {
      const local = this.findLocalCandidates(intent.description);
      let candidates = local.map((candidate) => candidate.track);
      if ((local[0]?.score ?? 0) < 0.35) {
        const searchQuery = intent.searchQuery?.trim() || intent.description;
        const remote = await this.ncm.searchSongs(searchQuery).catch(() => []);
        candidates = dedupeTracks([...candidates, ...remote]).slice(0, 12);
      }
      if (candidates.length === 0) {
        response = this.reply(
          "noop",
          "这次还没找到特别合适的歌呀。再给我一点关键词吧，比如年代、声线、节奏或心情～",
          this.state
        );
        callbacks.onTextDelta(response.reply);
        queueSpeech(segmenter.push(response.reply));
        queueSpeech(segmenter.finish());
      } else {
        const selection = await this.aiDjAssistant
          .selectTrack(intent.description, candidates, context)
          .catch((): TrackSelection => ({
            trackId: candidates[0]?.id,
            reason: "候选里它最贴近这次描述。"
          }));
        const target =
          candidates.find((track) => track.id === selection.trackId) ?? candidates[0];
        if (!target) {
          response = this.reply(
            "noop",
            "这次还没找到特别合适的歌呀～再给我一点关键词，我继续帮你挑！",
            this.state
          );
          callbacks.onTextDelta(response.reply);
          queueSpeech(segmenter.push(response.reply));
          queueSpeech(segmenter.finish());
        } else {
          const purpose =
            `request description: ${intent.description}; selection reason: ${selection.reason}`;
          const suggestionReason =
            selection.reason || `request description: ${intent.description}`;
          const prefix =
            `我挑了《${target.title}》- ${target.artists.join(" / ")} 给你～想听的话，点一下卡片就好！\n`;
          response = await streamReply(
            this.aiDjAssistant.commentTrackStream(target, context, purpose),
            fallbackComment(target),
            "play_by_description",
            prefix,
            this.createTrackSuggestion(target, suggestionReason)
          );
        }
      }
    } else {
      response = await this.handleChatIntent(message, context, intent);
      callbacks.onTextDelta(response.reply);
      queueSpeech(segmenter.push(prepareSpeechText(response.reply)));
      queueSpeech(segmenter.finish());
    }

    callbacks.onResult(response);
    await speechWork;
    return response;
  }

  private async handleChatIntent(
    message: string,
    context: AiDjContext,
    intent: AiDjIntent
  ): Promise<ChatResponse> {
    switch (intent.type) {
      case "skip":
        if (this.state.track) {
          await this.handleFeedback({ type: "skip", trackId: this.state.track.id });
        }
        return this.reply("skip", "好呀，下一首来啦～", await this.nextTrack());
      case "pause":
        this.state.paused = true;
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("pause", "好哦，先帮你暂停啦，想继续时喊我一声就好～", this.state);
      case "resume":
        this.state.paused = false;
        if (!this.state.track) {
          await this.nextTrack();
        }
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("resume", "继续播放啦，接着听吧～", this.state);
      case "replan":
        this.desiredMood = intent.desiredMood;
        await this.nextTrack(true);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("replan", `好呀，已经换成 ${intent.desiredMood} 风格啦，我继续按这个方向放歌～`, this.state);
      case "comment_current":
        return this.commentCurrentTrack(context);
      case "play_specific":
        return this.suggestSpecific(intent);
      case "play_by_description":
        return this.suggestByDescription(intent, context);
      case "chat":
      default: {
        const aiStatus = this.aiDjAssistant.status();
        const reply = aiStatus.configured
          ? await this.aiDjAssistant
              .chat(message, context)
              .catch((error) => aiFallbackNotice(aiStatus.provider, error, fallbackChatReply(message, context)))
          : aiNotConfiguredNotice(fallbackChatReply(message, context));
        return this.reply("noop", reply, this.state);
      }
    }
  }

  async importRecommendations(): Promise<RecommendationImportResponse> {
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const environment = this.getEnvironment();
    const result = await this.recommendationImporter.importRecommendations(profile, environment);
    if (result.importedCount > 0) {
      await this.refreshTasteProfile();
      this.state.queue = [];
      await this.ensureQueue();
    }
    await this.broadcastSystemStatus();
    return {
      ...result,
      environment,
      systemStatus: await this.getSystemStatus()
    };
  }

  private async classifySafely(message: string, context: AiDjContext): Promise<AiDjIntent> {
    try {
      return await this.aiDjAssistant.classify(message, context);
    } catch {
      return fallbackClassify(message);
    }
  }

  private buildAiContext(): AiDjContext {
    return {
      messages: this.repo.getRecentMessages(this.chatHistoryLimit()).map(({ role, text, at }) => ({
        role,
        text,
        at
      })),
      nowTrack: this.state.track,
      queue: this.state.queue.slice(0, 10),
      taste: this.repo.getTasteProfile()
    };
  }

  private chatHistoryLimit(): number {
    return Math.max(2, this.memoryTurns * 2);
  }

  private async suggestSpecific(intent: Extract<AiDjIntent, { type: "play_specific" }>): Promise<ChatResponse> {
    const query = intent.searchQuery?.trim() || intent.query.trim();
    const matches = await this.ncm.searchSongs(query);
    const target = matches[0];
    if (!target) {
      return this.reply("noop", `唔，这次没搜到《${query}》～换个歌名或歌手告诉我，我再帮你找找！`, this.state);
    }
    const comment = await this.aiDjAssistant
      .commentTrack(target, this.buildAiContext(), `direct song request: ${query}`)
      .catch(() => fallbackComment(target));
    return this.reply(
      "play_specific",
      `我挑了《${target.title}》- ${target.artists.join(" / ")} 给你～想听的话，点一下卡片就好！\n${comment}`,
      this.state,
      this.createTrackSuggestion(target, `direct song request: ${query}`)
    );
  }

  private async suggestByDescription(
    intent: Extract<AiDjIntent, { type: "play_by_description" }>,
    context: AiDjContext
  ): Promise<ChatResponse> {
    const local = this.findLocalCandidates(intent.description);
    let candidates = local.map((candidate) => candidate.track);
    const bestLocalScore = local[0]?.score ?? 0;
    if (bestLocalScore < 0.35) {
      const searchQuery = intent.searchQuery?.trim() || intent.description;
      const remote = await this.ncm.searchSongs(searchQuery).catch(() => []);
      candidates = dedupeTracks([...candidates, ...remote]).slice(0, 12);
    }

    if (candidates.length === 0) {
      return this.reply(
        "noop",
        "这次还没找到特别合适的歌呀。再给我一点关键词吧，比如年代、声线、节奏或心情～",
        this.state
      );
    }

    const selection = await this.aiDjAssistant
      .selectTrack(intent.description, candidates, context)
      .catch((): TrackSelection => ({ trackId: candidates[0]?.id, reason: "候选里它最贴近这次描述。" }));
    const target = candidates.find((track) => track.id === selection.trackId) ?? candidates[0];
    if (!target) {
      return this.reply("noop", "这次还没找到特别合适的歌呀～再给我一点关键词，我继续帮你挑！", this.state);
    }

    const comment = await this.aiDjAssistant
      .commentTrack(
        target,
        this.buildAiContext(),
        `request description: ${intent.description}; selection reason: ${selection.reason}`
      )
      .catch(() => fallbackComment(target));
    return this.reply(
      "play_by_description",
      `我挑了《${target.title}》- ${target.artists.join(" / ")} 给你～想听的话，点一下卡片就好！\n${comment}`,
      this.state,
      this.createTrackSuggestion(target, selection.reason || `request description: ${intent.description}`)
    );
  }

  private async commentCurrentTrack(context: AiDjContext): Promise<ChatResponse> {
    if (!this.state.track) {
      return this.reply("comment_current", "现在还没有歌在播放呀～先点一首，播起来后我陪你一起听！", this.state);
    }
    const reply = await this.aiDjAssistant.commentCurrent(context).catch(() => fallbackComment(this.state.track!));
    return this.reply("comment_current", reply, this.state);
  }

  private findLocalCandidates(description: string): Array<{ track: Track; score: number }> {
    return this.repo
      .getTrackStats(800)
      .map((entry) => ({
        track: entry.track,
        score: scoreTrackForDescription(entry, description)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }

  private async maybeGenerateDj(): Promise<void> {
    if (this.completedTracksSinceLastDj < this.djBroadcastInterval) {
      return;
    }
    if (!this.state.track) {
      return;
    }
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const script = await this.djBrain.generate({
      profile,
      nowTrack: this.state.track,
      upcoming: this.state.queue.slice(0, 3),
      settings: this.getDjSettings()
    });
    const voiced = await this.ttsPipeline.synthesize(script);
    this.state.djScript = voiced;
    this.repo.saveDjScript(voiced);
    this.wsHub.broadcast({ event: "dj_tts_ready", data: voiced });
    this.completedTracksSinceLastDj = 0;
  }

  private startImportRetryLoop(): void {
    if (this.importRetryTimer) {
      return;
    }
    if (this.repo.getTrackStatsCount() > 0) {
      return;
    }
    this.importRetryTimer = setInterval(() => {
      void this.retryImportIfNeeded();
    }, this.importRetryIntervalMs);
    this.importRetryTimer.unref?.();
  }

  private stopImportRetryLoop(): void {
    if (!this.importRetryTimer) {
      return;
    }
    clearInterval(this.importRetryTimer);
    this.importRetryTimer = undefined;
  }

  private async retryImportIfNeeded(): Promise<void> {
    if (this.repo.getTrackStatsCount() > 0) {
      this.stopImportRetryLoop();
      return;
    }
    const importedCount = await this.runNcmImport();
    if (importedCount > 0) {
      await this.postImportRefresh();
      this.stopImportRetryLoop();
    }
    await this.broadcastSystemStatus();
  }

  private async runNcmImport(): Promise<number> {
    if (this.importInFlight) {
      this.lastImportError = "导入任务正在进行中。";
      this.lastImportErrorCode = "ncm_import_in_progress";
      return 0;
    }

    this.importInFlight = true;
    this.lastImportAt = new Date().toISOString();
    try {
      const stats = await this.ncm.fetchUserMusicData();
      if (stats.length === 0) {
        this.lastImportError = "网易云导入完成，但连接器没有返回曲目。";
        this.lastImportErrorCode = "ncm_track_details_empty";
        return 0;
      }
      this.repo.upsertTrackStats(stats);
      this.lastImportError = undefined;
      this.lastImportErrorCode = undefined;
      return stats.length;
    } catch (error) {
      this.lastImportError = error instanceof Error ? error.message : String(error);
      this.lastImportErrorCode =
        error instanceof NcmImportError ? error.code : "ncm_request_failed";
      return 0;
    } finally {
      this.importInFlight = false;
    }
  }

  private async postImportRefresh(): Promise<void> {
    await this.refreshTasteProfile();
    await this.ensureQueue();
    if (!this.state.track && this.state.queue.length > 0) {
      await this.nextTrack();
      return;
    }
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  private async broadcastSystemStatus(): Promise<void> {
    this.wsHub.broadcast({ event: "system_status", data: await this.getSystemStatus() });
  }

  private ensureDjSettings(): DjSettings {
    const settings = this.repo.getDjSettings() ?? DEFAULT_DJ_SETTINGS;
    this.repo.saveDjSettings(settings);
    this.ttsPipeline.setVoice(settings.voice);
    return settings;
  }

  private async hydrateTrack(item: RadioPlanItem): Promise<{ item: RadioPlanItem; lyrics: TrackLyrics }> {
    const lyrics = await this.ncm.fetchLyrics(item.track.id);
    if (item.track.songUrl) {
      return { item, lyrics };
    }
    const songUrl = await this.ncm.resolveSongUrl(item.track.id);
    if (!songUrl) {
      return { item, lyrics };
    }
    this.repo.patchTrackSongUrl(item.track.id, songUrl);
    return {
      item: {
        ...item,
        track: {
          ...item.track,
          songUrl
        }
      },
      lyrics
    };
  }

  private createTrackSuggestion(track: Track, reason: string): TrackSuggestion {
    return {
      id: `suggestion_${track.id}_${Date.now()}`,
      track,
      reason,
      createdAt: new Date().toISOString()
    };
  }

  private reply(
    action: ChatResponse["action"],
    reply: string,
    now: NowPlayingState,
    trackSuggestion?: TrackSuggestion
  ): ChatResponse {
    const message = { role: "assistant" as const, text: reply, at: new Date().toISOString() };
    this.repo.addChatMessage(trackSuggestion ? { ...message, trackSuggestion } : message);
    return {
      action,
      reply,
      now,
      messages: this.repo.getRecentMessages(this.chatHistoryLimit())
    };
  }
}

function dedupeByTrackId(items: RadioPlanItem[]): RadioPlanItem[] {
  const seen = new Set<number>();
  const output: RadioPlanItem[] = [];
  for (const item of items) {
    if (seen.has(item.track.id)) {
      continue;
    }
    seen.add(item.track.id);
    output.push(item);
  }
  return output;
}

function dedupeTracks(items: Track[]): Track[] {
  const seen = new Set<number>();
  const output: Track[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

function scoreTrackForDescription(entry: { track: Track; playCount: number }, description: string): number {
  const text = `${entry.track.title} ${entry.track.artists.join(" ")} ${entry.track.album ?? ""}`.toLowerCase();
  const desc = description.toLowerCase();
  let score = Math.min(0.2, entry.playCount / 500);

  const rules: Array<{ pattern: RegExp; moods: string[]; words: string[]; weight: number }> = [
    { pattern: /雨|rain|下雨/, moods: ["calm", "night", "warm"], words: ["rain", "雨"], weight: 0.28 },
    { pattern: /夜|凌晨|深夜|晚|night|midnight/, moods: ["night"], words: ["night", "midnight", "nocturne", "deep"], weight: 0.45 },
    { pattern: /代码|工作|学习|专注|focus|coding/, moods: ["focus"], words: ["focus", "code", "work"], weight: 0.45 },
    { pattern: /电子|低频|edm|bass|electro/, moods: ["energy", "focus"], words: ["bass", "electro", "edm", "synth"], weight: 0.35 },
    { pattern: /散步|安静|平静|calm|walk/, moods: ["calm", "night", "warm"], words: ["walk", "quiet", "calm"], weight: 0.25 },
    { pattern: /怀旧|经典|nostalgia|old/, moods: ["nostalgia"], words: ["old", "classic"], weight: 0.32 }
  ];

  for (const rule of rules) {
    if (!rule.pattern.test(desc)) {
      continue;
    }
    if (entry.track.moodTag && rule.moods.includes(entry.track.moodTag)) {
      score += rule.weight;
    }
    if (rule.words.some((word) => text.includes(word))) {
      score += rule.weight;
    }
  }

  for (const token of desc.split(/\s+/).filter((part) => part.length >= 2)) {
    if (text.includes(token)) {
      score += 0.2;
    }
  }

  return score;
}

function aiNotConfiguredNotice(fallback: string): string {
  return `DeepSeek 还没连接好（未检测到 DEEPSEEK_API_KEY 或 OPENAI_API_KEY），我先用本地 DJ 模式陪你聊～\n${fallback}`;
}

function aiFallbackNotice(provider: string, error: unknown, fallback: string): string {
  const label = provider === "deepseek" ? "DeepSeek" : "AI";
  return `${label} 刚刚开了个小差，已经切到本地 DJ 模式啦：${summarizeAiError(error)}\n${fallback}`;
}

function summarizeAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 160);
}
