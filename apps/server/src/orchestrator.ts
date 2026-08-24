import fs from "node:fs";

import { createExtensionProviders } from "./providers.js";

import type {
  ChatMemory,
  ChatResponse,
  DjSettings,
  EnvironmentContext,
  EnvironmentLocationRequest,
  FavoriteResponse,
  FeedbackRequest,
  ImportNcmResponse,
  MusicCommandRequest,
  MusicCommandResult,
  MusicSource,
  MusicSourceStatus,
  MusicSourceSyncResponse,
  DailyPlan,
  PlayDailyPlanResponse,
  RecommendationImportResponse,
  NowPlayingState,
  NcmImportErrorCode,
  PlayEvent,
  RadioPlanItem,
  SystemStatus,
  TasteProfile,
  Track,
  TrackReference,
  TrackLyrics,
  TrackSuggestion,
  VoiceTurnCompleteRequest,
  VoiceTurnStartRequest
} from "@musicgpt/shared";
import type { AiDjAssistant, AiDjContext, AiDjIntent, TrackSelection } from "./aiDjAssistant.js";
import { fallbackClassify } from "./aiDjAssistant.js";
import { ConversationKernel } from "./conversationKernel.js";
import { DjBrain } from "./djBrain.js";
import { EnvironmentService, isWeatherFresh } from "./environmentService.js";
import { NcmConnector, NcmImportError } from "./ncmConnector.js";
import { MusicCommandModule } from "./musicCommand.js";
import { MusicCatalog, getTrackKey, normalizeTrackReference, sourceIdFromKey } from "./musicCatalog.js";
import { DailyPlanEngine, playbackSegment, rollingWindow } from "./dailyPlan.js";
import type { RoutineProvider } from "./routineProvider.js";
import { TasteDocumentManager } from "./tasteDocuments.js";
import { TrackTagEnricher } from "./trackTagEnricher.js";
import { RadioPlanner } from "./radioPlanner.js";
import { RecommendationImporter } from "./recommendationImporter.js";
import {
  hasRecommendationMetadata,
  isEligibleRecommendationTrack,
  isExplicitAmbientRequest
} from "./recommendationQuality.js";
import { StateRepository } from "./stateRepository.js";
import { TasteEngine } from "./tasteEngine.js";
import { currentPeriod } from "./time.js";
import {
  environmentTags,
  inferTrackTags,
  periodLabel,
  tagsFromContextText,
  weatherLabel
} from "./trackTags.js";
import { WsHub } from "./wsHub.js";

const PLAN_WINDOW_SIZE = 10;
const QUEUE_TARGET_SIZE = 10;
const QUEUE_REFILL_THRESHOLD = 6;
const IMPORT_RETRY_INTERVAL_MS = 60_000;
const CHAT_HISTORY_DISPLAY_LIMIT = 100;
const RECOMMENDATION_DATA_VERSION = 2;
const RECOMMENDATION_FEEDBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const SOURCE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AI_OPEN_ENDED_REPLY_UNCONFIGURED =
  "尚未连接 DeepSeek/OpenAI，当前无法生成开放式回复。";
const AI_OPEN_ENDED_REPLY_FAILED =
  "DeepSeek 暂时没能生成可信的回复，请重试。";
const AI_COMMENT_REPLY_FAILED =
  "DeepSeek 暂时没能生成可信的点评；这次不使用本地套话。";
export const DEFAULT_DJ_SETTINGS: DjSettings = {
  tone: "lively",
  voiceGender: "female",
  voice: "marin"
};

type EnvironmentRuntime = Pick<EnvironmentService, "getContext" | "updateLocation"> & {
  refreshIfStale?(context?: EnvironmentContext): Promise<EnvironmentContext>;
  getTimeline?(date: string, timezone: string): Promise<import("@musicgpt/shared").EnvironmentTimeline>;
};

export interface ChatStreamCallbacks {
  onTextDelta(delta: string): void;
  onResult(response: ChatResponse): void;
}

export type QueuedTrackPlaybackErrorCode = "qq_subscription_required" | "qq_playback_unavailable";

export class QueuedTrackPlaybackError extends Error {
  constructor(readonly code: QueuedTrackPlaybackErrorCode) {
    super(code);
    this.name = "QueuedTrackPlaybackError";
  }
}

export class RadioOrchestrator {
  private state: NowPlayingState = { queue: [], paused: false };
  private desiredMood?: string;
  private completedTracksSinceLastDj = 0;
  private importRetryTimer: ReturnType<typeof setInterval> | undefined;
  private sourceSyncTimer: ReturnType<typeof setInterval> | undefined;
  private importInFlight = false;
  private lastImportAt: string | undefined;
  private lastImportError: string | undefined;
  private lastImportErrorCode: NcmImportErrorCode | undefined;
  private realtimeLastError: string | undefined;
  private readonly conversation: ConversationKernel;
  private readonly musicCommands: MusicCommandModule;

  constructor(
    private readonly repo: StateRepository,
    private readonly ncm: NcmConnector,
    private readonly tasteEngine: TasteEngine,
    private readonly planner: RadioPlanner,
    private readonly djBrain: DjBrain,
    private readonly aiDjAssistant: AiDjAssistant,
    private readonly wsHub: WsHub,
    private readonly djBroadcastInterval: number,
    private readonly memoryTurns: number,
    private readonly importRetryIntervalMs: number = IMPORT_RETRY_INTERVAL_MS,
    private readonly environmentService: EnvironmentRuntime = new EnvironmentService(),
    private readonly recommendationImporter: RecommendationImporter = new RecommendationImporter(repo, ncm),
    private readonly realtimeConversationMode: "unified" | "legacy" = "unified",
    private readonly catalog?: MusicCatalog,
    private readonly tasteDocuments?: TasteDocumentManager,
    private readonly routineProvider?: RoutineProvider,
    private readonly dailyPlanEngine?: DailyPlanEngine,
    private readonly tagEnricher?: TrackTagEnricher,
    private readonly timezone = "Asia/Shanghai"
  ) {
    this.conversation = new ConversationKernel(repo, aiDjAssistant, wsHub, memoryTurns);
    this.musicCommands = new MusicCommandModule(repo, {
      getNow: () => this.state,
      classify: async (request) => {
        const context = this.buildAiContext(request);
        return this.classifySafely(request, context);
      },
      searchSongs: (query) => this.catalog?.search(query) ?? this.ncm.searchSongs(query),
      playTrack: (track, reason) => this.playSuggestedTrack(track, reason),
      setFavorite: async (trackId, favorite) => {
        await this.setFavorite(trackId, favorite);
      },
      replay: async (trackId) => {
        await this.handleFeedback({ type: "replay", trackId });
      },
      handleIntent: async (request, intent, mode) => {
        const context = this.buildAiContext(request);
        const response = await this.handleChatIntent(request, context, intent);
        const suggestion = response.messages[0]?.trackSuggestion;
        if (
          mode === "voice_direct" &&
          suggestion &&
          (response.action === "play_by_description" || response.action === "play_atmosphere")
        ) {
          const now = await this.playSuggestedTrack(suggestion.track, suggestion.reason);
          return { action: response.action, outcome: "executed", summary: response.reply, now };
        }
        const executed = ["skip", "pause", "resume", "replan"].includes(response.action);
        return {
          action: response.action,
          outcome: executed ? "executed" : "answered",
          summary: response.reply,
          now: response.now,
          ...(suggestion ? { suggestion } : {})
        };
      }
    });
  }

  async initialize(): Promise<void> {
    this.state = this.repo.getNowPlaying() ?? { queue: [], paused: false };
    this.ensureDjSettings();
    await this.repairRecommendationData();
    await this.refreshEnvironmentIfNeeded();
    if (this.repo.getTrackStatsCount() === 0) {
      await this.runNcmImport();
    }
    await this.refreshTasteProfile();
    this.catalog?.registerTracks(this.repo.getTrackStats(5000).map((stat) => stat.track));
    if (this.catalog) {
      const qqStatus = (await this.catalog.statuses()).find((status) => status.source === "qq");
      if (qqStatus?.connected) await this.syncMusicSource("qq").catch(() => undefined);
    }
    if (
      this.lastImportErrorCode !== "ncm_unreachable" &&
      this.lastImportErrorCode !== "ncm_request_failed" &&
      this.lastImportErrorCode !== "ncm_not_logged_in"
    ) {
      await this.refreshRecommendationCandidates(false).catch(() => undefined);
    }
    if (this.state.track) {
      this.repo.ensureTrack(this.state.track);
      this.state.isFavorite = this.repo.isTrackFavorite(this.state.track.id);
    }
    if (
      this.state.track &&
      (!this.state.lyrics ||
        normalizeTrackReference(this.state.lyrics.trackId) !== getTrackKey(this.state.track))
    ) {
      if (this.catalog) {
        this.state.lyrics = await this.catalog.getLyrics(this.state.track);
      } else {
        const ncmId = ncmNumericId(this.state.track);
        if (ncmId !== undefined) this.state.lyrics = await this.ncm.fetchLyrics(ncmId);
      }
      this.repo.saveNowPlaying(this.state);
    }
    await this.ensureQueue();
    if (!this.state.track && this.state.queue.length > 0) {
      await this.nextTrack();
    }
    this.startImportRetryLoop();
    this.startSourceSyncLoop();
    await this.tasteDocuments?.flush();

    for (const provider of createExtensionProviders()) {
      await provider.refresh().catch(() => undefined);
    }
    await this.broadcastSystemStatus();
  }

  async close(): Promise<void> {
    this.stopImportRetryLoop();
    if (this.sourceSyncTimer) clearInterval(this.sourceSyncTimer);
    this.sourceSyncTimer = undefined;
    await this.tasteDocuments?.flush();
    await this.conversation.waitForIdle();
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

  getTasteWithDocument(): (TasteProfile & {
    manualRules: ReturnType<TasteDocumentManager["readRules"]>["rules"];
    document: ReturnType<TasteDocumentManager["readRules"]>["status"];
  }) | undefined {
    const profile = this.getTaste();
    if (!profile) return undefined;
    const parsed = this.tasteDocuments?.readRules();
    return {
      ...profile,
      manualRules: parsed?.rules ?? { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      document: parsed?.status ?? {
        path: "",
        valid: true,
        manualRules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] }
      }
    };
  }

  async getMusicSources(): Promise<MusicSourceStatus[]> {
    if (this.catalog) return this.catalog.statuses();
    return [{
      source: "ncm",
      enabled: true,
      connected: await this.ncm.isReachable(),
      capabilities: {
        accountLibrary: true, recentPlays: true, search: true,
        recommendations: true, playback: true, lyrics: true
      }
    }];
  }

  async syncMusicSource(source: MusicSource): Promise<MusicSourceSyncResponse> {
    if (!this.catalog) {
      if (source !== "ncm") throw new Error("music_source_unavailable:qq");
      const importedCount = await this.runNcmImport();
      const status = (await this.getMusicSources())[0]!;
      return { source, importedCount, evidenceCount: 0, warnings: [], status };
    }
    const result = await this.catalog.sync(source);
    if (source === "ncm") {
      await this.runNcmImport();
    } else {
      const tracks = this.tagEnricher
        ? await this.tagEnricher.enrich(result.tracks)
        : result.tracks;
      const platformLikes = new Map(
        result.evidence
          .filter((item) => item.kind === "platform_like")
          .map((item) => [item.trackKey, item.observedAt])
      );
      this.repo.upsertTrackStats(tracks.map((track) => ({
        track,
        playCount: 0,
        ...(track.trackKey && platformLikes.has(track.trackKey)
          ? { likedAt: platformLikes.get(track.trackKey)! }
          : {})
      })));
    }
    this.repo.upsertLibraryEvidence(result.evidence);
    await this.refreshTasteProfile();
    await this.tasteDocuments?.flush();
    const plan = await this.regenerateDailyPlan(true);
    if (plan) {
      this.state.queue = rollingWindow(plan, new Date(), QUEUE_TARGET_SIZE);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    }
    const status = (await this.catalog.statuses()).find((item) => item.source === source)!;
    this.wsHub.broadcast({ event: "music_sources_updated", data: await this.catalog.statuses() });
    await this.broadcastSystemStatus();
    return {
      source,
      importedCount: result.tracks.length,
      evidenceCount: result.evidence.length,
      warnings: result.warnings,
      status
    };
  }

  getLibraryExport(): unknown {
    if (!this.tasteDocuments) return { version: 2, recordings: [] };
    this.tasteDocuments.ensureFiles();
    return JSON.parse(fs.readFileSync(this.tasteDocuments.libraryPath, "utf8")) as unknown;
  }

  async getDailyPlan(force = false): Promise<DailyPlan | undefined> {
    const plan = await this.regenerateDailyPlan(force);
    if (force && plan) {
      this.state.queue = rollingWindow(plan, new Date(), QUEUE_TARGET_SIZE);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    }
    return plan;
  }

  async playCurrentDailyPlanSegment(): Promise<PlayDailyPlanResponse | undefined> {
    const plan = await this.regenerateDailyPlan(false);
    if (!plan) return undefined;
    const segment = playbackSegment(plan, new Date());
    if (!segment) return undefined;
    const consumed = new Set(plan.consumedTrackKeys);
    const remaining = segment.items.filter((item) => !consumed.has(getTrackKey(item.track)));
    if (remaining.length === 0) return undefined;
    this.state.queue = remaining.slice(0, QUEUE_TARGET_SIZE);
    const now = await this.nextTrack();
    const updatedPlan = this.repo.getDailyPlan() ?? plan;
    const updatedConsumed = new Set(updatedPlan.consumedTrackKeys);
    this.state.queue = segment.items
      .filter((item) => !updatedConsumed.has(getTrackKey(item.track)))
      .slice(0, QUEUE_TARGET_SIZE);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    this.recordExplicitPlay(now.track ? getTrackKey(now.track) : undefined);
    return { period: segment.period, now: this.state };
  }

  getEnvironment(): EnvironmentContext {
    const context = this.repo.getEnvironmentContext() ?? this.environmentService.getContext();
    const weatherIsUsable = context.weather === "unknown" || isWeatherFresh(context);
    return {
      ...context,
      dayPeriod: currentPeriod(),
      weather: weatherIsUsable ? context.weather : "unknown"
    };
  }

  async updateEnvironmentLocation(location: EnvironmentLocationRequest): Promise<EnvironmentContext> {
    const context = await this.environmentService.updateLocation(location);
    this.repo.saveEnvironmentContext(context);
    await this.regenerateDailyPlan(true);
    this.state.queue = [];
    await this.ensureQueue();
    await this.broadcastSystemStatus();
    return context;
  }

  getDjSettings(): DjSettings {
    return this.repo.getDjSettings() ?? DEFAULT_DJ_SETTINGS;
  }

  async updateDjSettings(settings: DjSettings): Promise<DjSettings> {
    const requestedVoice = settings.voice.trim();
    const normalized: DjSettings = {
      tone: settings.tone,
      voiceGender: settings.voiceGender,
      voice: !requestedVoice || requestedVoice.includes("Neural")
        ? DEFAULT_DJ_SETTINGS.voice
        : requestedVoice
    };
    this.repo.saveDjSettings(normalized);
    await this.broadcastSystemStatus();
    return normalized;
  }

  getChatHistory(): { messages: ChatResponse["messages"] } {
    return this.conversation.getHistory();
  }

  startVoiceTurn(input: VoiceTurnStartRequest) {
    return this.conversation.startVoiceTurn(input);
  }

  completeVoiceTurn(turnId: string, input: VoiceTurnCompleteRequest) {
    return this.conversation.completeVoiceTurn(turnId, input);
  }

  buildRealtimeContext(sessionId: string, baselineRevision?: number) {
    const taste = this.repo.getTasteProfile();
    return this.conversation.buildRealtimeContext({
      sessionId,
      ...(baselineRevision !== undefined ? { baselineRevision } : {}),
      now: this.state,
      ...(taste ? { taste } : {}),
      environment: this.getEnvironment()
    });
  }

  executeMusicCommand(request: MusicCommandRequest): Promise<MusicCommandResult> {
    return this.musicCommands.execute(request);
  }

  getChatMemories(): { memories: ChatMemory[] } {
    return this.conversation.getMemories();
  }

  deleteChatMemory(memoryId: number): boolean {
    return this.conversation.deleteMemory(memoryId);
  }

  clearChatMemories(): { ok: true; memories: [] } {
    this.conversation.clearMemories();
    return { ok: true, memories: [] };
  }

  clearChatHistory(): { ok: true; messages: [] } {
    this.conversation.clearHistory();
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
      queueLength: this.state.queue.length,
      realtimeConversationMode: this.realtimeConversationMode,
      inputTranscriptionEnabled: this.realtimeConversationMode === "unified"
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
    if (this.realtimeLastError) {
      status.realtimeLastError = this.realtimeLastError;
    }
    status.environment = this.getEnvironment();
    status.djSettings = this.getDjSettings();
    status.musicSources = await this.getMusicSources();
    const tasteStatus = this.tasteDocuments?.readRules().status;
    if (tasteStatus) status.tasteDocument = tasteStatus;
    const routineStatus = this.routineProvider?.status?.();
    if (routineStatus) status.routineDocument = routineStatus;
    const dailyPlan = this.repo.getDailyPlan();
    if (dailyPlan) status.dailyPlanRevision = dailyPlan.revision;
    return status;
  }

  async reportRealtimeError(code: string): Promise<void> {
    this.realtimeLastError = code.trim().slice(0, 200);
    await this.broadcastSystemStatus();
  }

  async refreshTasteProfile(): Promise<TasteProfile> {
    const profile = this.tasteEngine.generate(
      this.repo.getTrackStats(),
      this.repo.getRecentPlayEvents(200)
    );
    this.repo.saveTasteProfile(profile);
    this.tasteDocuments?.schedule({
      profile,
      stats: this.repo.getTrackStats(5000),
      events: this.repo.getRecentPlayEvents(5000),
      libraryEvidence: this.repo.getLibraryEvidence()
    });
    this.wsHub.broadcast({ event: "taste_updated", data: this.getTasteWithDocument() ?? profile });
    return profile;
  }

  async ensureQueue(forceFill = false): Promise<void> {
    const previousDailyPlan = this.repo.getDailyPlan();
    const hadUsableQueue = this.state.queue.length >= QUEUE_REFILL_THRESHOLD;
    const dailyPlan = await this.regenerateDailyPlan(false);
    if (dailyPlan) {
      // Keep a healthy rolling window stable. This also lets an in-flight v1
      // queue drain naturally after migration instead of replacing it at
      // startup. Short caller-inserted queues (for example an explicit song
      // request) stay at the front while the daily plan fills behind them.
      const contextChanged = Boolean(
        previousDailyPlan && previousDailyPlan.contextHash !== dailyPlan.contextHash
      );
      const previousPlanKeys = new Set(
        previousDailyPlan?.segments.flatMap((segment) =>
          segment.items.map((item) => getTrackKey(item.track))
        ) ?? []
      );
      const queueOwnedByPlan = this.state.queue.length > 0 && this.state.queue.every((item) =>
        previousPlanKeys.has(getTrackKey(item.track))
      );
      if (!forceFill && hadUsableQueue && (!contextChanged || !queueOwnedByPlan)) return;
      const planned = rollingWindow(dailyPlan, new Date(), QUEUE_TARGET_SIZE);
      const explicit = this.state.queue.filter((item) => item.source === "chat_search");
      this.state.queue = contextChanged
        ? dedupeByTrackId([...explicit, ...planned]).slice(0, QUEUE_TARGET_SIZE)
        : dedupeByTrackId([...this.state.queue, ...planned]).slice(0, QUEUE_TARGET_SIZE);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
      return;
    }
    if (!forceFill && this.state.queue.length >= QUEUE_REFILL_THRESHOLD) return;
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const planOptions = this.desiredMood
      ? {
          windowSize: PLAN_WINDOW_SIZE,
          desiredMood: this.desiredMood,
          environment: this.getEnvironment(),
          candidates: this.repo.getRecommendationCandidates(),
          contextTags: this.buildRecommendationContextTags()
        }
      : {
          windowSize: PLAN_WINDOW_SIZE,
          environment: this.getEnvironment(),
          candidates: this.repo.getRecommendationCandidates(),
          contextTags: this.buildRecommendationContextTags()
        };
    const planned = this.planner.plan(
      this.repo.getTrackStats(),
      profile,
      this.getRecommendationFeedbackEvents(),
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
    this.repo.ensureTrack(next.track);
    const resolved = await this.hydrateTrack(next);
    if (next.track.source === "qq" && !resolved.item.track.songUrl) {
      this.recordUnavailableTrack(next.track);
      await this.ensureQueue(true);
      return this.nextTrack(false);
    }
    return this.activateResolvedTrack(resolved, getTrackKey(next.track));
  }

  private async activateResolvedTrack(
    resolved: { item: RadioPlanItem; lyrics: TrackLyrics },
    plannedTrackKey?: string
  ): Promise<NowPlayingState> {
    this.state.track = resolved.item.track;
    this.state.lyrics = resolved.lyrics;
    this.state.startedAt = new Date().toISOString();
    this.state.paused = false;
    this.state.isFavorite = this.repo.isTrackFavorite(getTrackKey(resolved.item.track));
    const dailyPlan = this.repo.getDailyPlan();
    if (dailyPlan) {
      const consumedKeys = new Set([
        getTrackKey(resolved.item.track),
        ...(plannedTrackKey ? [plannedTrackKey] : [])
      ]);
      let changed = false;
      for (const key of consumedKeys) {
        if (dailyPlan.consumedTrackKeys.includes(key)) continue;
        dailyPlan.consumedTrackKeys.push(key);
        changed = true;
      }
      if (changed) this.repo.saveDailyPlan(dailyPlan);
    }

    await this.ensureQueue();

    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    return this.state;
  }

  async playSuggestedTrack(track: Track, reason?: string): Promise<NowPlayingState> {
    const normalizedTrack = {
      ...track,
      tags: inferTrackTags(track)
    };
    this.repo.ensureTrack(normalizedTrack);
    this.state.queue.unshift({
      track: normalizedTrack,
      score: 0.99,
      reason: reason?.trim() || `用户点播 · ${normalizedTrack.title}`,
      source: "chat_search",
      bucket: "explore"
    });
    const now = await this.nextTrack();
    this.recordExplicitPlay(now.track ? getTrackKey(now.track) : undefined);
    return now;
  }

  async playQueuedTrack(trackId: TrackReference): Promise<NowPlayingState | undefined> {
    const trackKey = normalizeTrackReference(trackId);
    const queueIndex = this.state.queue.findIndex((item) => getTrackKey(item.track) === trackKey);
    if (queueIndex < 0) {
      return undefined;
    }
    const target = this.state.queue[queueIndex]!;
    const resolved = await this.hydrateTrack(target);
    if (target.track.source === "qq" && !resolved.item.track.songUrl) {
      this.state.queue.splice(0, queueIndex + 1);
      this.recordUnavailableTrack(target.track);
      await this.ensureQueue(true);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
      throw new QueuedTrackPlaybackError(
        target.track.requiresSubscription ? "qq_subscription_required" : "qq_playback_unavailable"
      );
    }
    this.state.queue.splice(0, queueIndex + 1);
    const now = await this.activateResolvedTrack(resolved, getTrackKey(target.track));
    this.recordExplicitPlay(now.track ? getTrackKey(now.track) : undefined);
    return now;
  }

  private recordUnavailableTrack(track: Track): void {
    const failedKey = getTrackKey(track);
    this.repo.addPlayEvent({
      type: "skip",
      trackId: failedKey,
      at: new Date().toISOString(),
      metadata: {
        reason: track.requiresSubscription ? "subscription_required" : "playback_unavailable"
      }
    });
    const failedPlan = this.repo.getDailyPlan();
    if (failedPlan && !failedPlan.consumedTrackKeys.includes(failedKey)) {
      failedPlan.consumedTrackKeys.push(failedKey);
      this.repo.saveDailyPlan(failedPlan);
    }
  }

  async handleFeedback(feedback: FeedbackRequest): Promise<void> {
    const environment = this.getEnvironment();
    const event: PlayEvent = {
      type: feedback.type,
      trackId: feedback.trackId,
      at: new Date().toISOString(),
      ...(feedback.type === "like" || feedback.type === "unlike"
        ? { metadata: this.favoriteEventMetadata(environment) }
        : {})
    };
    this.repo.addPlayEvent(event);
    if (feedback.type === "like") {
      this.repo.markTrackLiked(feedback.trackId, event.at);
    }
    if (feedback.type === "unlike") {
      this.repo.setTrackFavorite(feedback.trackId, false, event.at);
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
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, new Date(), QUEUE_TARGET_SIZE);
    if (
      this.state.track &&
      getTrackKey(this.state.track) === normalizeTrackReference(feedback.trackId)
    ) {
      this.state.isFavorite = this.repo.isTrackFavorite(feedback.trackId);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  async setFavorite(trackId: TrackReference, favorite: boolean): Promise<FavoriteResponse> {
    const trackKey = normalizeTrackReference(trackId);
    if (this.state.track && getTrackKey(this.state.track) === trackKey) {
      this.repo.ensureTrack({
        ...this.state.track,
        tags: inferTrackTags(this.state.track)
      });
    }
    const wasFavorite = this.repo.isTrackFavorite(trackId);
    if (wasFavorite !== favorite) {
      const at = new Date().toISOString();
      this.repo.setTrackFavorite(trackId, favorite, at);
      this.repo.addPlayEvent({
        type: favorite ? "like" : "unlike",
        trackId,
        at,
        metadata: this.favoriteEventMetadata(this.getEnvironment())
      });
    }
    const taste = await this.refreshTasteProfile();
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, new Date(), QUEUE_TARGET_SIZE);
    if (this.state.track && getTrackKey(this.state.track) === trackKey) {
      this.state.isFavorite = favorite;
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    return { favorite: this.repo.isTrackFavorite(trackId), taste };
  }

  async handleChat(message: string, turnId?: string): Promise<ChatResponse> {
    const model = this.aiDjAssistant.status().model;
    return this.conversation.respondText(
      {
        message,
        now: this.state,
        ...(turnId ? { turnId } : {}),
        ...(model ? { model } : {})
      },
      async () => {
        const context = this.buildAiContext(message);
        const intent = await this.classifySafely(message, context);
        const response = await this.handleChatIntent(message, context, intent);
        const suggestion = response.messages[0]?.trackSuggestion;
        if (
          (response.action === "play_specific" ||
            response.action === "play_by_description" ||
            response.action === "play_atmosphere") &&
          suggestion
        ) {
          const now = await this.playSuggestedTrack(suggestion.track, suggestion.reason);
          const playbackReply = response.action === "play_specific"
            ? `已切到《${suggestion.track.title}》— ${formatArtists(suggestion.track)}。`
            : `${suggestion.reason}，已切到《${suggestion.track.title}》— ${formatArtists(suggestion.track)}。`;
          return {
            action: response.action,
            reply: playbackReply,
            now
          };
        }
        return {
          action: response.action,
          reply: response.reply,
          now: response.now,
          ...(suggestion ? { trackSuggestion: suggestion } : {})
        };
      }
    );
  }

  async handleChatStream(
    message: string,
    callbacks: ChatStreamCallbacks,
    turnId?: string
  ): Promise<ChatResponse> {
    const response = await this.handleChat(message, turnId);
    callbacks.onTextDelta(response.reply);
    callbacks.onResult(response);
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
          await this.handleFeedback({ type: "skip", trackId: getTrackKey(this.state.track) });
        }
        return this.reply("skip", "已切到下一首。", await this.nextTrack());
      case "pause":
        this.state.paused = true;
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("pause", "已暂停播放。", this.state);
      case "resume":
        this.state.paused = false;
        if (!this.state.track) {
          await this.nextTrack();
        }
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("resume", "已继续播放。", this.state);
      case "replan":
        this.desiredMood = intent.desiredMood;
        await this.nextTrack(true);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("replan", `已切换为 ${intent.desiredMood} 风格。`, this.state);
      case "comment_current":
        return this.commentCurrentTrack(context);
      case "play_specific":
        return this.suggestSpecific(intent);
      case "play_by_description":
        return this.suggestByDescription(intent, context);
      case "play_atmosphere":
        return this.suggestAtmosphere();
      case "chat":
      default: {
        const aiStatus = this.aiDjAssistant.status();
        const reply = aiStatus.configured
          ? await this.aiDjAssistant
              .chat(message, context)
              .catch(() => AI_OPEN_ENDED_REPLY_FAILED)
          : AI_OPEN_ENDED_REPLY_UNCONFIGURED;
        return this.reply("noop", reply, this.state);
      }
    }
  }

  async importRecommendations(): Promise<RecommendationImportResponse> {
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const environment = await this.refreshEnvironmentIfNeeded();
    const result = await this.recommendationImporter.importRecommendations(
      profile,
      environment,
      this.recentUserContextText(),
      true
    );
    if (result.importedCount > 0) {
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

  private buildAiContext(message = ""): AiDjContext {
    return {
      messages: this.conversation.recentContextMessages(this.chatContextLimit()).map(({ role, text, at }) => ({
        role,
        text,
        at
      })),
      memories: this.conversation.relevantMemories(message),
      nowTrack: this.state.track,
      queue: this.state.queue.slice(0, 10),
      taste: this.repo.getTasteProfile(),
      environment: this.getEnvironment(),
      contextTags: this.buildRecommendationContextTags(),
      recentFeedback: this.repo.getRecentPlayEvents(20)
    };
  }

  private chatContextLimit(): number {
    return Math.max(2, this.memoryTurns * 2);
  }

  private async suggestSpecific(intent: Extract<AiDjIntent, { type: "play_specific" }>): Promise<ChatResponse> {
    const query = intent.searchQuery?.trim() || intent.query.trim();
    const matches = await (this.catalog?.search(query) ?? this.ncm.searchSongs(query));
    const target = matches[0];
    if (!target) {
      return this.reply("noop", `没有搜到《${query}》，请换一个歌名或艺人。`, this.state);
    }
    const reason = formatEvidence(["点歌", compactEvidence(query)]);
    return this.reply(
      "play_specific",
      `找到《${target.title}》— ${formatArtists(target)}。`,
      this.state,
      this.createTrackSuggestion(target, reason)
    );
  }

  private async suggestByDescription(
    intent: Extract<AiDjIntent, { type: "play_by_description" }>,
    context: AiDjContext
  ): Promise<ChatResponse> {
    const allowAmbient = isExplicitAmbientRequest(
      `${intent.description} ${intent.searchQuery ?? ""}`
    );
    const local = this.findLocalCandidates(intent.description, allowAmbient);
    let candidates = local.map((candidate) => candidate.track);
    const bestLocalScore = local[0]?.score ?? 0;
    if (bestLocalScore < 0.35) {
      const searchQuery = intent.searchQuery?.trim() || intent.description;
      const remote = (await (this.catalog?.search(searchQuery) ?? this.ncm.searchSongs(searchQuery)).catch(() => []))
        .filter((track) => isEligibleRecommendationTrack(track, allowAmbient));
      candidates = dedupeTracks([...candidates, ...remote]).slice(0, 12);
    }

    if (candidates.length === 0) {
      return this.reply(
        "noop",
        "没有找到符合条件的歌曲，请补充年代、声线、节奏或心情等关键词。",
        this.state
      );
    }

    const selection = await this.aiDjAssistant
      .selectTrack(intent.description, candidates, context)
      .catch((): TrackSelection => ({ trackId: candidates[0]?.id }));
    const target = candidates.find((track) =>
      selection.trackId !== undefined && getTrackKey(track) === normalizeTrackReference(selection.trackId)
    ) ?? candidates[0];
    if (!target) {
      return this.reply("noop", "没有找到符合条件的歌曲，请补充关键词。", this.state);
    }

    const reason = descriptionEvidence(intent.description, target);
    return this.reply(
      "play_by_description",
      `${reason}，选了《${target.title}》— ${formatArtists(target)}。`,
      this.state,
      this.createTrackSuggestion(target, reason)
    );
  }

  private async suggestAtmosphere(): Promise<ChatResponse> {
    const environment = await this.refreshEnvironmentIfNeeded();
    await this.refreshRecommendationCandidates().catch(() => undefined);
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const context = this.buildAiContext();
    const plan = this.planner.plan(
      this.repo.getTrackStats(),
      profile,
      this.getRecommendationFeedbackEvents(),
      {
        windowSize: 12,
        environment,
        candidates: this.repo.getRecommendationCandidates(),
        contextTags: this.buildRecommendationContextTags(),
        ...(this.desiredMood ? { desiredMood: this.desiredMood } : {})
      }
    );
    const candidates = plan.map((item) => item.track);
    if (candidates.length === 0) {
      return this.reply(
        "noop",
        "候选曲库尚未准备好；同步网易云后可再次使用氛围点歌。",
        this.state
      );
    }
    const description = this.atmosphereDescription(environment);
    const selection = await this.aiDjAssistant
      .selectTrack(description, candidates, context)
      .catch((): TrackSelection => ({
        trackId: candidates[0]?.id
      }));
    const target = candidates.find((track) =>
      selection.trackId !== undefined && getTrackKey(track) === normalizeTrackReference(selection.trackId)
    ) ?? candidates[0];
    if (!target) {
      return this.reply("noop", "当前候选中没有合适的歌曲，请稍后重试。", this.state);
    }
    const planItem = plan.find((item) => getTrackKey(item.track) === getTrackKey(target));
    const reason = atmosphereEvidence(
      environment,
      planItem?.reason,
      this.desiredMood
    );
    return this.reply(
      "play_atmosphere",
      `${reason}，选了《${target.title}》— ${formatArtists(target)}。`,
      this.state,
      this.createTrackSuggestion(target, reason)
    );
  }

  private async commentCurrentTrack(context: AiDjContext): Promise<ChatResponse> {
    if (!this.state.track) {
      return this.reply("comment_current", "当前没有歌曲在播放，请先点一首。", this.state);
    }
    const aiStatus = this.aiDjAssistant.status();
    const reply = aiStatus.configured
      ? await this.aiDjAssistant.commentCurrent(context).catch(() => AI_COMMENT_REPLY_FAILED)
      : AI_OPEN_ENDED_REPLY_UNCONFIGURED;
    return this.reply("comment_current", reply, this.state);
  }

  private findLocalCandidates(
    description: string,
    allowAmbient = false
  ): Array<{ track: Track; score: number }> {
    const stats = this.repo.getTrackStats(800);
    const knownIds = new Set(stats.map((entry) => entry.track.id));
    const exploration = this.repo
      .getRecommendationCandidates(300)
      .filter((candidate) => !knownIds.has(candidate.track.id))
      .map((candidate) => ({ track: candidate.track, playCount: 0 }));
    return [...stats, ...exploration]
      .filter((entry) => isEligibleRecommendationTrack(entry.track, allowAmbient))
      .map((entry) => ({
        track: entry.track,
        score: scoreTrackForDescription(entry, description)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }

  private async refreshEnvironmentIfNeeded(): Promise<EnvironmentContext> {
    const stored = this.repo.getEnvironmentContext() ?? this.environmentService.getContext();
    if (!this.environmentService.refreshIfStale) {
      return this.getEnvironment();
    }
    const refreshed = await this.environmentService.refreshIfStale(stored).catch(() => ({
      ...stored,
      dayPeriod: currentPeriod(),
      weather: "unknown" as const,
      updatedAt: new Date().toISOString()
    }));
    this.repo.saveEnvironmentContext(refreshed);
    return this.getEnvironment();
  }

  private async refreshRecommendationCandidates(includeSearch = true): Promise<void> {
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    await this.recommendationImporter.importRecommendations(
      profile,
      this.getEnvironment(),
      this.recentUserContextText(),
      false,
      includeSearch
    );
  }

  private recentUserContextText(): string {
    return this.repo
      .getRecentMessages(30)
      .filter((message) => message.role === "user")
      .slice(-6)
      .map((message) => message.text)
      .join(" ");
  }

  private buildRecommendationContextTags() {
    const tags = [
      ...environmentTags(this.getEnvironment()),
      ...tagsFromContextText(this.recentUserContextText())
    ];
    if (this.desiredMood) {
      tags.push({ category: "mood" as const, value: this.desiredMood });
    }
    return tags;
  }

  private favoriteEventMetadata(
    environment: EnvironmentContext
  ): NonNullable<PlayEvent["metadata"]> {
    const scenes = tagsFromContextText(this.recentUserContextText())
      .filter((tag) => tag.category === "scene")
      .map((tag) => tag.value);
    return {
      period: periodLabel(environment.dayPeriod),
      weather: environment.weather === "unknown" ? "未知天气" : weatherLabel(environment.weather),
      contextTags: scenes.join("|")
    };
  }

  private atmosphereDescription(environment: EnvironmentContext): string {
    const parts = [
      environment.weather === "unknown" ? undefined : weatherLabel(environment.weather),
      periodLabel(environment.dayPeriod),
      ...tagsFromContextText(this.recentUserContextText())
        .filter((tag) => tag.category === "scene" || tag.category === "style")
        .slice(0, 3)
        .map((tag) => tag.value),
      this.desiredMood
    ].filter(Boolean);
    return parts.length > 0 ? parts.join("、") : "当前时段和最近口味";
  }

  private async maybeGenerateDj(): Promise<void> {
    if (this.completedTracksSinceLastDj < this.djBroadcastInterval) {
      return;
    }
    if (!this.state.track) {
      return;
    }
    if (this.conversation.hasActiveTurn()) {
      return;
    }
    const trackId = this.state.track.id;
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const script = await this.djBrain.generate({
      profile,
      nowTrack: this.state.track,
      upcoming: this.state.queue.slice(0, 3),
      settings: this.getDjSettings()
    });
    this.completedTracksSinceLastDj = 0;
    if (!script || this.conversation.hasActiveTurn() || this.state.track?.id !== trackId) {
      return;
    }
    this.state.djScript = script;
    this.repo.saveDjScript(script);
    this.wsHub.broadcast({ event: "dj_script_ready", data: script });
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
      const rawStats = await this.ncm.fetchUserMusicData();
      const enriched = this.tagEnricher
        ? await this.tagEnricher.enrich(rawStats.map((stat) => stat.track))
        : rawStats.map((stat) => stat.track);
      const stats = rawStats.map((stat, index) => ({ ...stat, track: enriched[index] ?? stat.track }));
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
    await this.repairMissingTrackMetadata();
    await this.refreshTasteProfile();
    await this.tasteDocuments?.flush();
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

  private getRecommendationFeedbackEvents(): PlayEvent[] {
    return this.repo.getPlayEventsSince(
      new Date(Date.now() - RECOMMENDATION_FEEDBACK_WINDOW_MS).toISOString()
    );
  }

  private async regenerateDailyPlan(force: boolean): Promise<DailyPlan | undefined> {
    if (!this.dailyPlanEngine || !this.routineProvider || !this.tasteDocuments) return undefined;
    const date = localDateKeyForTimezone(new Date(), this.timezone);
    const previous = this.repo.getDailyPlan();
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const parsed = this.tasteDocuments.readRules();
    const timeline = await this.environmentService.getTimeline?.(date, this.timezone).catch(() => undefined);
    const next = this.dailyPlanEngine.generate({
      date,
      timezone: this.timezone,
      stats: this.repo.getTrackStats(5000),
      profile,
      rules: parsed.rules,
      routine: this.routineProvider.getBlocks(date, this.timezone),
      weather: this.getEnvironment(),
      feedback: this.getRecommendationFeedbackEvents(),
      ...(timeline ? { weatherByPeriod: weatherByPeriod(timeline.points) } : {}),
      ...(previous ? { previous, consumedTrackKeys: previous.consumedTrackKeys } : {}),
      ...(this.state.track ? { currentTrackKey: getTrackKey(this.state.track) } : {})
    });
    if (!force && previous?.date === date && previous.contextHash === next.contextHash) {
      return previous;
    }
    this.repo.saveDailyPlan(next);
    this.wsHub.broadcast({ event: "daily_plan_updated", data: next });
    return next;
  }

  private startSourceSyncLoop(): void {
    if (!this.catalog || this.sourceSyncTimer) return;
    this.sourceSyncTimer = setInterval(() => {
      void this.catalog!.statuses().then(async (statuses) => {
        for (const status of statuses) {
          if (status.connected) await this.syncMusicSource(status.source).catch(() => undefined);
        }
      });
    }, SOURCE_SYNC_INTERVAL_MS);
    this.sourceSyncTimer.unref?.();
  }

  private recordExplicitPlay(trackId: TrackReference | undefined): void {
    if (trackId === undefined) {
      return;
    }
    this.repo.addPlayEvent({
      type: "play",
      trackId,
      at: new Date().toISOString()
    });
  }

  private async repairRecommendationData(): Promise<void> {
    if (this.repo.getRecommendationDataVersion() < RECOMMENDATION_DATA_VERSION) {
      this.repo.clearRecommendationCandidates();
      this.repo.resetRecommendationRefreshDates();
      this.state.queue = [];
      this.repo.saveNowPlaying(this.state);
      this.repo.saveRecommendationDataVersion(RECOMMENDATION_DATA_VERSION);
    }
    await this.repairMissingTrackMetadata();
  }

  private async repairMissingTrackMetadata(): Promise<void> {
    const incomplete = this.repo
      .getTrackStats(5000)
      .filter((stat) => stat.track.source !== "qq" && !hasRecommendationMetadata(stat.track));
    if (incomplete.length === 0) {
      return;
    }
    const details = await this.ncm
      .fetchTrackDetails(incomplete.flatMap((stat) => {
        const id = ncmNumericId(stat.track);
        return id === undefined ? [] : [id];
      }))
      .catch(() => []);
    const detailsById = new Map(details.map((track) => [getTrackKey(track), track]));
    const repaired = incomplete.flatMap((stat) => {
      const detail = detailsById.get(getTrackKey(stat.track));
      if (!detail || !hasRecommendationMetadata(detail)) {
        return [];
      }
      const track: Track = {
        ...stat.track,
        ...detail,
        ...(stat.track.moodTag ? { moodTag: stat.track.moodTag } : {}),
        ...(stat.track.tags ? { tags: stat.track.tags } : {}),
        ...(stat.track.songUrl ? { songUrl: stat.track.songUrl } : {})
      };
      return [{ ...stat, track }];
    });
    if (repaired.length === 0) {
      return;
    }
    this.repo.upsertTrackStats(repaired);
    const currentRepair = this.state.track
      ? repaired.find((stat) => getTrackKey(stat.track) === getTrackKey(this.state.track!))
      : undefined;
    if (currentRepair) {
      this.state.track = currentRepair.track;
      this.repo.saveNowPlaying(this.state);
    }
  }

  private ensureDjSettings(): DjSettings {
    const stored = this.repo.getDjSettings();
    const settings = stored
      ? {
          ...stored,
          voice: stored.voice.includes("Neural") ? DEFAULT_DJ_SETTINGS.voice : stored.voice
        }
      : DEFAULT_DJ_SETTINGS;
    this.repo.saveDjSettings(settings);
    return settings;
  }

  private async hydrateTrack(item: RadioPlanItem): Promise<{ item: RadioPlanItem; lyrics: TrackLyrics }> {
    if (this.catalog) {
      const [lyrics, playback] = await Promise.all([
        this.catalog.getLyrics(item.track),
        item.track.songUrl ? Promise.resolve(undefined) : this.catalog.resolvePlayback(item.track)
      ]);
      if (!playback) return { item, lyrics };
      this.repo.ensureTrack(playback.track);
      this.repo.patchTrackSongUrl(playback.track.trackKey!, playback.url);
      return {
        item: { ...item, track: playback.track },
        lyrics
      };
    }
    const ncmId = ncmNumericId(item.track);
    if (ncmId === undefined) {
      return {
        item,
        lyrics: { trackId: getTrackKey(item.track), pureMusic: true, lines: [] }
      };
    }
    const lyrics = await this.ncm.fetchLyrics(ncmId);
    if (item.track.songUrl) {
      return { item, lyrics };
    }
    const songUrl = await this.ncm.resolveSongUrl(ncmId);
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
    return {
      action,
      reply,
      now,
      messages: [trackSuggestion ? { ...message, trackSuggestion } : message]
    };
  }
}

function dedupeByTrackId(items: RadioPlanItem[]): RadioPlanItem[] {
  const seen = new Set<string>();
  const output: RadioPlanItem[] = [];
  for (const item of items) {
    const trackKey = getTrackKey(item.track);
    if (seen.has(trackKey)) {
      continue;
    }
    seen.add(trackKey);
    output.push(item);
  }
  return output;
}

function dedupeTracks(items: Track[]): Track[] {
  const seen = new Set<string>();
  const output: Track[] = [];
  for (const item of items) {
    const trackKey = getTrackKey(item);
    if (seen.has(trackKey)) {
      continue;
    }
    seen.add(trackKey);
    output.push(item);
  }
  return output;
}

function ncmNumericId(track: Track): number | undefined {
  const trackKey = getTrackKey(track);
  if (!trackKey.startsWith("ncm:")) return undefined;
  const numeric = Number(sourceIdFromKey(trackKey));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function localDateKeyForTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function weatherByPeriod(
  points: import("@musicgpt/shared").EnvironmentForecastPoint[]
): Partial<Record<import("@musicgpt/shared").DayPeriod, Pick<EnvironmentContext, "weather" | "temperature">>> {
  const hours: Record<import("@musicgpt/shared").DayPeriod, number> = {
    morning: 7,
    afternoon: 13,
    evening: 18,
    late_night: 22
  };
  return Object.fromEntries(Object.entries(hours).flatMap(([period, target]) => {
    const point = [...points].sort((left, right) =>
      Math.abs(hourFromForecast(left.at) - target) - Math.abs(hourFromForecast(right.at) - target)
    )[0];
    return point
      ? [[period, {
          weather: point.weather,
          ...(point.temperature !== undefined ? { temperature: point.temperature } : {})
        }]]
      : [];
  }));
}

function hourFromForecast(value: string): number {
  const match = value.match(/T(\d{2}):/u);
  return match ? Number(match[1]) : 0;
}

function scoreTrackForDescription(entry: { track: Track; playCount: number }, description: string): number {
  const tagText = inferTrackTags(entry.track).map((tag) => tag.value).join(" ");
  const text = `${entry.track.title} ${entry.track.artists.join(" ")} ${entry.track.album ?? ""} ${tagText}`.toLowerCase();
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

function descriptionEvidence(description: string, track: Track): string {
  const requestedTags = tagsFromContextText(description).map((tag) => tag.value);
  const mood = track.moodTag && track.moodTag !== "unknown"
    ? moodLabel(track.moodTag)
    : undefined;
  const evidence = [...requestedTags, mood].filter((value): value is string => Boolean(value));
  if (evidence.length > 0) {
    return formatEvidence(evidence);
  }
  return `条件「${compactEvidence(description)}」`;
}

function atmosphereEvidence(
  environment: EnvironmentContext,
  plannerReason: string | undefined,
  desiredMood: string | undefined
): string {
  const plannerParts = plannerReason
    ?.split(/\s*\+\s*/u)
    .map((part) => part.trim())
    .filter(Boolean) ?? [];
  const fallbackParts = [
    environment.weather === "unknown" ? undefined : weatherLabel(environment.weather),
    periodLabel(environment.dayPeriod)
  ].filter((value): value is string => Boolean(value));
  const desired = desiredMood ? moodLabel(desiredMood) : undefined;
  return formatEvidence([
    ...(plannerParts.length > 0 ? plannerParts : fallbackParts),
    ...(desired ? [desired] : [])
  ]);
}

function formatEvidence(parts: string[]): string {
  const seen = new Set<string>();
  return parts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || seen.has(part)) {
        return false;
      }
      seen.add(part);
      return true;
    })
    .slice(0, 4)
    .join(" · ");
}

function compactEvidence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const chars = [...normalized];
  return chars.length <= 32 ? normalized : `${chars.slice(0, 32).join("")}…`;
}

function moodLabel(mood: string): string {
  const labels: Record<string, string> = {
    calm: "平静",
    focus: "专注",
    warm: "温暖",
    night: "夜听",
    energy: "高能",
    nostalgia: "怀旧"
  };
  return labels[mood] ?? mood;
}

function formatArtists(track: Track): string {
  return track.artists.filter(Boolean).join(" / ") || "未知艺人";
}

function isOpenEndedFailureReply(reply: string): boolean {
  return (
    reply === AI_OPEN_ENDED_REPLY_UNCONFIGURED ||
    reply === AI_OPEN_ENDED_REPLY_FAILED ||
    reply === AI_COMMENT_REPLY_FAILED
  );
}
