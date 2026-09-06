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
  IntelligencePolicyMode,
  LearningReceipt,
  ListeningConstraint,
  MusicActionStep,
  MusicCommandRequest,
  MusicCommandResult,
  MusicTag,
  MusicSource,
  MusicSourceStatus,
  MusicSourceSyncResponse,
  DailyPlan,
  PlayDailyPlanResponse,
  RecommendationImportResponse,
  NowPlayingState,
  NcmImportErrorCode,
  PlaybackOutcomeRequest,
  PlayEvent,
  RadioPlanItem,
  RecommendationCandidate,
  SessionIntent,
  SystemStatus,
  TasteProfile,
  TasteResponse,
  TasteManualRules,
  TasteSignalMutationRequest,
  TasteSignal,
  Track,
  TrackReference,
  TrackStat,
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
import { IntelligencePolicyController } from "./intelligencePolicy.js";
import {
  DAILY_PLAN_QUOTA_GUARDS,
  ListeningPolicy,
  satisfiesListeningConstraints,
  type LearningReceipt as PolicyLearningReceipt,
  type PreferenceSignal,
  type RankedDecision
} from "./listeningPolicy.js";
import { NcmConnector, NcmImportError } from "./ncmConnector.js";
import { MusicCommandModule } from "./musicCommand.js";
import {
  MusicCatalog,
  getTrackKey,
  normalizeTrackIdentity,
  normalizeTrackReference,
  sourceIdFromKey
} from "./musicCatalog.js";
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

interface ContextualPlanInput {
  profile: TasteProfile;
  environment: EnvironmentContext;
  stats?: TrackStat[];
  candidates?: RecommendationCandidate[];
  contextTags?: MusicTag[];
  desiredMood?: string;
  constraints?: ListeningConstraint[];
  allowAmbient?: boolean;
  windowSize?: number;
}

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
  private desiredMood: string | undefined;
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
  private readonly intelligencePolicy: IntelligencePolicyController;
  private readonly listeningPolicy: ListeningPolicy;
  private listeningSessionId: string = crypto.randomUUID();
  private lastListeningInteractionAt = 0;
  private readonly shadowRankings = new Map<string, RankedDecision[]>();
  private readonly playbackOutcomeInFlight = new Map<
    string,
    Promise<{ duplicate: boolean; learningReceipt?: LearningReceipt }>
  >();

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
    private readonly timezone = "Asia/Shanghai",
    intelligencePolicyMode?: IntelligencePolicyMode,
    listeningPolicy?: ListeningPolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    this.intelligencePolicy = new IntelligencePolicyController(
      {
        load: () => this.repo.getIntelligencePolicyState(),
        save: (state) => this.repo.saveIntelligencePolicyState(state)
      },
      {
        ...(intelligencePolicyMode ? { environmentMode: intelligencePolicyMode } : {}),
        now: this.now
      }
    );
    this.listeningPolicy = listeningPolicy ?? new ListeningPolicy({
      state: this.repo.loadListeningPolicyState(),
      persistence: this.repo
    });
    this.conversation = new ConversationKernel(repo, aiDjAssistant, wsHub, memoryTurns);
    this.musicCommands = new MusicCommandModule(repo, {
      getNow: () => this.state,
      ...(this.aiDjAssistant.plan
        ? {
            plan: async (request: string) =>
              this.aiDjAssistant.plan!(request, this.buildAiContext(request))
          }
        : {}),
      classify: async (request) => {
        const context = this.buildAiContext(request);
        return this.classifySafely(request, context);
      },
      searchSongs: (query) => this.catalog?.search(query) ?? this.ncm.searchSongs(query),
      resolveTrack: (trackId) => this.findTrack(trackId),
      playTrack: (track, reason, planItem) => this.playSuggestedTrack(track, reason, planItem),
      setFavorite: async (trackId, favorite) => {
        const result = await this.setFavorite(trackId, favorite);
        return result.learningReceipt;
      },
      replay: async (trackId) => {
        const track = this.findTrack(trackId);
        if (!track) throw new Error("replay_track_unavailable");
        await this.playSuggestedTrack(track, "重播已听歌曲");
        await this.handleFeedback({ type: "replay", trackId });
      },
      handleAction: async (request, action, constraints) =>
        this.handleStructuredAction(request, action, constraints),
      handleIntent: async (request, intent, mode, constraints = []) => {
        const context = this.buildAiContext(request);
        const response = await this.handleChatIntent(request, context, intent, constraints);
        const suggestion = response.messages[0]?.trackSuggestion;
        if (
          mode === "voice_direct" &&
          suggestion &&
          (response.action === "play_by_description" || response.action === "play_atmosphere")
        ) {
          const now = await this.playSuggestedTrack(
            suggestion.track,
            suggestion.reason,
            suggestion.planItem
          );
          return { action: response.action, outcome: "executed", summary: response.reply, now };
        }
        const executed = ["skip", "pause", "resume", "replan"].includes(response.action);
        return {
          action: response.action,
          outcome: executed ? "executed" : "answered",
          summary: response.reply,
          now: response.now,
          ...(response.learningReceipt ? { learningReceipt: response.learningReceipt } : {}),
          ...(suggestion ? { suggestion } : {})
        };
      }
    });
  }

  async initialize(): Promise<void> {
    this.state = this.repo.getNowPlaying() ?? { queue: [], paused: false };
    const startupAt = this.now();
    this.repo.expireSessionIntents(startupAt.toISOString());
    const activeIntents = this.repo.getActiveSessionIntents(startupAt.toISOString());
    const persistedSession = this.repo.getListeningSessionState();
    const persistedAt = persistedSession ? Date.parse(persistedSession.lastInteractionAt) : Number.NaN;
    if (
      persistedSession &&
      Number.isFinite(persistedAt) &&
      startupAt.getTime() >= persistedAt &&
      startupAt.getTime() - persistedAt < 2 * 60 * 60_000
    ) {
      this.listeningSessionId = persistedSession.sessionId;
      this.lastListeningInteractionAt = persistedAt;
    } else {
      const resumedSession = activeIntents.find((intent) =>
        intent.scope === "session" &&
        intent.sessionId &&
        startupAt.getTime() - Date.parse(intent.updatedAt) < 2 * 60 * 60_000
      );
      if (resumedSession?.sessionId) {
        this.listeningSessionId = resumedSession.sessionId;
        this.lastListeningInteractionAt = Date.parse(resumedSession.updatedAt);
      }
    }
    this.desiredMood = this.activeDesiredMood(startupAt);
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

  getTasteWithDocument(): TasteResponse | undefined {
    const profile = this.getTaste();
    if (!profile) return undefined;
    const parsed = this.tasteDocuments?.readRules();
    const at = this.now().getTime();
    const observationsById = new Map(
      this.repo.loadListeningPolicyState().observations.map((observation) => [observation.observationId, observation])
    );
    const structuredSignals = this.listeningPolicy.profile().signals
      .filter((signal) => !signal.reversedAt)
      .filter((signal) => !signal.expiresAt || Date.parse(signal.expiresAt) > at)
      .map((signal) => this.toTasteSignal(
        signal,
        new Set(signal.observationIds.flatMap((observationId) => {
          const sessionId = observationsById.get(observationId)?.sessionId;
          return sessionId ? [sessionId] : [];
        })).size
      ));
    return {
      ...profile,
      manualRules: parsed?.rules ?? { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      document: parsed?.status ?? {
        path: "",
        valid: true,
        manualRules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] }
      },
      signals: {
        explicit: structuredSignals.filter((signal) => signal.source === "explicit"),
        implicit: structuredSignals.filter((signal) => signal.source === "implicit"),
        legacy: [
          ...structuredSignals.filter((signal) => signal.source === "legacy"),
          ...this.legacyBaselineSignals()
        ]
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
      this.state.queue = rollingWindow(plan, this.now(), QUEUE_TARGET_SIZE);
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
      this.state.queue = rollingWindow(plan, this.now(), QUEUE_TARGET_SIZE);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    }
    return plan;
  }

  async playCurrentDailyPlanSegment(): Promise<PlayDailyPlanResponse | undefined> {
    const availablePlan = await this.regenerateDailyPlan(false);
    if (!availablePlan) return undefined;
    const availableSegment = playbackSegment(availablePlan, new Date());
    if (!availableSegment) return undefined;
    const availableConsumed = new Set(availablePlan.consumedTrackKeys);
    if (availableSegment.items.every((item) => availableConsumed.has(getTrackKey(item.track)))) return undefined;
    await this.finalizeCurrentPlaybackAsSkipped();
    const plan = await this.regenerateDailyPlan(false) ?? availablePlan;
    const segment = playbackSegment(plan, new Date()) ?? availableSegment;
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

  executeMusicCommand(request: MusicCommandRequest, preplanned?: import("@musicgpt/shared").MusicActionPlan): Promise<MusicCommandResult> {
    this.beginListeningInteraction();
    return this.musicCommands.execute(request, undefined, preplanned);
  }

  touchListeningInteraction(): void {
    this.beginListeningInteraction();
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
      inputTranscriptionEnabled: this.realtimeConversationMode === "unified",
      intelligencePolicy: this.intelligencePolicy.status()
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
    const desiredMood = this.activeDesiredMood();
    const constraints = this.activeListeningConstraints();
    this.state.queue = this.state.queue.filter((item) => satisfiesListeningConstraints(item.track, constraints));
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
      const planned = rollingWindow(dailyPlan, this.now(), QUEUE_TARGET_SIZE);
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
    const planOptions = desiredMood
      ? {
          windowSize: PLAN_WINDOW_SIZE,
          desiredMood,
          constraints,
          environment: this.getEnvironment(),
          candidates: this.repo.getRecommendationCandidates(),
          contextTags: this.buildRecommendationContextTags(),
          ...(this.tasteDocuments ? { rules: this.tasteDocuments.readRules().rules } : {}),
          sessionId: this.listeningSessionId,
          policyMode: this.intelligencePolicy.mode(),
          onPolicyError: () => {
            this.intelligencePolicy.recordRankingFailure();
            this.shadowRankings.delete(this.getEnvironment().dayPeriod);
          },
          onShadowRanking: (decisions: RankedDecision[]) => {
            this.shadowRankings.set(this.getEnvironment().dayPeriod, decisions);
          }
        }
      : {
          windowSize: PLAN_WINDOW_SIZE,
          constraints,
          environment: this.getEnvironment(),
          candidates: this.repo.getRecommendationCandidates(),
          contextTags: this.buildRecommendationContextTags(),
          ...(this.tasteDocuments ? { rules: this.tasteDocuments.readRules().rules } : {}),
          sessionId: this.listeningSessionId,
          policyMode: this.intelligencePolicy.mode(),
          onPolicyError: () => {
            this.intelligencePolicy.recordRankingFailure();
            this.shadowRankings.delete(this.getEnvironment().dayPeriod);
          },
          onShadowRanking: (decisions: RankedDecision[]) => {
            this.shadowRankings.set(this.getEnvironment().dayPeriod, decisions);
          }
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

  async nextTrack(forceReplan = false, queuePrepared = false): Promise<NowPlayingState> {
    if (forceReplan) {
      this.state.queue = [];
    }
    if (!queuePrepared) {
      await this.ensureQueue();
    }
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
    const activatedAt = this.now().toISOString();
    const playbackId = crypto.randomUUID();
    this.state.track = resolved.item.track;
    this.state.lyrics = resolved.lyrics;
    this.state.playbackId = playbackId;
    this.state.startedAt = activatedAt;
    this.state.paused = false;
    this.state.isFavorite = this.repo.isTrackFavorite(getTrackKey(resolved.item.track));
    if (resolved.item.decisionId) {
      this.state.decision = {
        decisionId: resolved.item.decisionId,
        policyVersion: resolved.item.policyVersion ?? "legacy",
        evidence: resolved.item.evidence ?? [],
        summary: resolved.item.reason
      };
    } else {
      this.state.decision = {
        decisionId: `legacy:${playbackId}`,
        policyVersion: resolved.item.policyVersion ?? "legacy",
        evidence: resolved.item.evidence?.length
          ? resolved.item.evidence.slice(0, 3)
          : [{
              type: resolved.item.source === "chat_search" ? "source_availability" : "context",
              label: resolved.item.reason || "来自当前可播放队列",
              strength: 1,
              correctable: false
            }],
        summary: resolved.item.reason || "来自当前可播放队列"
      };
    }
    const environment = this.getEnvironment();
    const desiredMood = this.activeDesiredMood();
    if (resolved.item.source !== "chat_search") {
      this.recordShadowRecommendationAudit(environment.dayPeriod);
    }
    const eventBase = {
      trackId: getTrackKey(resolved.item.track),
      at: activatedAt,
      playbackId,
      ...(resolved.item.track.recordingKey ? { recordingKey: resolved.item.track.recordingKey } : {}),
      ...(resolved.item.track.source ? { source: resolved.item.track.source } : {}),
      ...(resolved.item.decisionId ? { decisionId: resolved.item.decisionId } : {}),
      ...(resolved.item.track.durationMs !== undefined ? { durationMs: resolved.item.track.durationMs } : {}),
      reason: resolved.item.reason,
      context: {
        dayPeriod: environment.dayPeriod,
        weather: environment.weather,
        ...(desiredMood ? { desiredMood } : {})
      }
    } satisfies Omit<PlayEvent, "type" | "eventId">;
    this.repo.addPlayEvent({ ...eventBase, eventId: `impression:${playbackId}`, type: "impression" });
    this.repo.addPlayEvent({ ...eventBase, eventId: `play-start:${playbackId}`, type: "play_start" });
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

  async playSuggestedTrack(
    track: Track,
    reason?: string,
    planItem?: RadioPlanItem
  ): Promise<NowPlayingState> {
    const normalizedTrack = {
      ...track,
      tags: inferTrackTags(track)
    };
    await this.finalizeCurrentPlaybackAsSkipped();
    this.repo.ensureTrack(normalizedTrack);
    this.state.queue.unshift(planItem
      ? { ...planItem, track: normalizedTrack }
      : {
          track: normalizedTrack,
          score: 0.99,
          reason: reason?.trim() || `用户点播 · ${normalizedTrack.title}`,
          source: "chat_search",
          bucket: "explore"
        });
    const now = await this.nextTrack(false, true);
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
    await this.finalizeCurrentPlaybackAsSkipped();
    this.state.queue.splice(0, queueIndex + 1);
    const now = await this.activateResolvedTrack(resolved, getTrackKey(target.track));
    this.recordExplicitPlay(now.track ? getTrackKey(now.track) : undefined);
    return now;
  }

  private recordUnavailableTrack(track: Track): void {
    const failedKey = getTrackKey(track);
    const at = this.now().toISOString();
    this.repo.addPlayEvent({
      eventId: `playback-error:${crypto.randomUUID()}`,
      type: "playback_error",
      trackId: failedKey,
      at,
      reason: track.requiresSubscription ? "subscription_required" : "playback_unavailable",
      ...(track.recordingKey ? { recordingKey: track.recordingKey } : {}),
      ...(track.source ? { source: track.source } : {})
    });
    this.listeningPolicy.observe({
      observationId: `playback-error:${failedKey}:${at}`,
      kind: "playback_outcome",
      track,
      at,
          sessionId: this.listeningSessionId,
      outcome: "playback_error"
    });
    const failedPlan = this.repo.getDailyPlan();
    if (failedPlan && !failedPlan.consumedTrackKeys.includes(failedKey)) {
      failedPlan.consumedTrackKeys.push(failedKey);
      this.repo.saveDailyPlan(failedPlan);
    }
  }

  async handleFeedback(feedback: FeedbackRequest): Promise<LearningReceipt> {
    const listeningSessionId = this.beginListeningInteraction();
    const environment = this.getEnvironment();
    const beforeQueue = this.state.queue.map((item) => getTrackKey(item.track));
    const at = this.now().toISOString();
    const track = this.findTrack(feedback.trackId);
    const favoriteBefore = track ? this.repo.isTrackFavorite(feedback.trackId) : undefined;
    const event: PlayEvent = {
      type:
        feedback.reason === "bad_version" || feedback.reason === "playback_problem"
          ? "playback_error"
          : feedback.type,
      trackId: feedback.trackId,
      at,
      ...(feedback.playbackId ? { playbackId: feedback.playbackId } : {}),
      ...(feedback.decisionId ? { decisionId: feedback.decisionId } : {}),
      ...(feedback.reason ? { reason: feedback.reason } : {}),
      ...(feedback.scope ? { scope: feedback.scope } : {}),
      ...(feedback.listenedMs !== undefined ? { listenedMs: feedback.listenedMs } : {}),
      ...(feedback.durationMs !== undefined ? { durationMs: feedback.durationMs } : {}),
      ...(track?.recordingKey ? { recordingKey: track.recordingKey } : {}),
      ...(track?.source ? { source: track.source } : {}),
      ...((feedback.type === "like" || feedback.type === "unlike") && !feedback.reason
        ? { metadata: this.favoriteEventMetadata(environment) }
        : {})
    };
    this.repo.addPlayEvent(event);
    if (feedback.type === "like") {
      this.repo.markTrackLiked(feedback.trackId, event.at);
    }
    // A recommendation correction and a favorite mutation are separate user
    // facts. Older clients sent `unlike + reason`; keep accepting that shape,
    // but only a reason-less unlike means "remove from favorites".
    if (feedback.type === "unlike" && !feedback.reason) {
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
    let policyReceipt: PolicyLearningReceipt | undefined;
    if (feedback.reason && track) {
      policyReceipt = this.listeningPolicy.observe({
          observationId: feedback.playbackId
            ? `feedback:${feedback.playbackId}:${feedback.type}:${feedback.reason}`
            : `feedback:${crypto.randomUUID()}`,
          kind: "explicit_feedback",
          track,
          at,
          sessionId: listeningSessionId,
          reason: feedback.reason,
          scope: feedback.scope ?? (["wrong_for_now", "bad_version", "playback_problem"].includes(feedback.reason)
            ? "session"
            : "long_term"),
          ...(feedback.decisionId ? { decisionId: feedback.decisionId } : {})
        });
    } else if (feedback.type === "replay" && track) {
      policyReceipt = this.listeningPolicy.observe({
            observationId: feedback.playbackId
              ? `replay:${feedback.playbackId}`
              : `replay:${crypto.randomUUID()}`,
            kind: "playback_outcome",
            track,
            at,
            sessionId: listeningSessionId,
            outcome: "replay",
            dayPeriod: environment.dayPeriod,
            ...(feedback.decisionId ? { decisionId: feedback.decisionId } : {})
          });
    } else if (feedback.type === "like" && track) {
      const normalized = normalizeTrackIdentity(track);
      policyReceipt = this.listeningPolicy.observe({
        observationId: feedback.playbackId
          ? `favorite:${feedback.playbackId}:like`
          : `favorite:${crypto.randomUUID()}:like`,
        kind: "explicit_feedback",
        track: normalized,
        at,
        sessionId: listeningSessionId,
        scope: "long_term",
        structuredPreferences: [{
          targetType: "recording",
          targetKey: normalized.recordingKey!,
          direction: "positive",
          strength: 0.8,
          label: "你明确收藏了这首录音"
        }],
        ...(favoriteBefore !== undefined ? { favoriteBefore, favoriteAfter: true } : {})
      });
    } else if (feedback.type === "unlike" && !feedback.reason && track) {
      const normalized = normalizeTrackIdentity(track);
      const favoriteSignal = this.listeningPolicy.profile().signals.find((signal) =>
        !signal.reversedAt &&
        signal.source === "explicit" &&
        signal.targetType === "recording" &&
        signal.targetKey === normalized.recordingKey &&
        signal.direction === "positive" &&
        signal.label.includes("收藏")
      );
      if (favoriteSignal) {
        policyReceipt = this.listeningPolicy.observe({
          observationId: feedback.playbackId
            ? `favorite:${feedback.playbackId}:unlike`
            : `favorite:${crypto.randomUUID()}:unlike`,
          kind: "signal_correction",
          track: normalized,
          at,
          scope: "long_term",
          targetSignalId: favoriteSignal.signalId,
          correction: "delete",
          ...(favoriteBefore !== undefined ? { favoriteBefore, favoriteAfter: false } : {})
        });
      }
    }
    await this.refreshTasteProfile();
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    if (
      track &&
      this.catalog &&
      (feedback.reason === "bad_version" || feedback.reason === "playback_problem") &&
      this.state.track &&
      getTrackKey(this.state.track) === getTrackKey(track)
    ) {
      const fallback = await this.catalog.resolvePlayback(track, getTrackKey(track));
      if (fallback) {
        const lyrics = await this.catalog.getLyrics(fallback.track).catch(() => ({
          trackId: getTrackKey(fallback.track),
          pureMusic: true,
          lines: []
        }));
        await this.activateResolvedTrack({
          item: {
            track: fallback.track,
            score: 1,
            reason: "版本纠正 · 严格同录音回退",
            bucket: "familiar",
            source: "library"
          },
          lyrics
        });
        if (policyReceipt) {
          policyReceipt.summary = `${policyReceipt.summary}，已切换到同一录音的可播放版本。`;
        }
      }
    }
    if (
      this.state.track &&
      getTrackKey(this.state.track) === normalizeTrackReference(feedback.trackId)
    ) {
      this.state.isFavorite = this.repo.isTrackFavorite(feedback.trackId);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    const replacedQueueCount = beforeQueue.filter((trackKey) => !afterKeys.has(trackKey)).length;
    if (policyReceipt) {
      policyReceipt.replacedQueueCount = replacedQueueCount;
      this.repo.saveLearningReceipt(policyReceipt);
    }
    const learningReceipt = policyReceipt
      ? this.toLearningReceipt(policyReceipt)
      : this.noopLearningReceipt(
          feedback.scope ?? "long_term",
          replacedQueueCount,
          feedback.type === "like"
            ? "已收藏这首歌，并用于后续推荐。"
            : feedback.type === "unlike"
              ? "已取消收藏。"
              : "已记录这次反馈。"
        );
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return learningReceipt;
  }

  async handlePlaybackOutcome(request: PlaybackOutcomeRequest): Promise<{
    duplicate: boolean;
    learningReceipt?: LearningReceipt;
  }> {
    const existing = this.playbackOutcomeInFlight.get(request.playbackId);
    if (existing) {
      return { ...(await existing), duplicate: true };
    }
    const pending = this.processPlaybackOutcome(request);
    this.playbackOutcomeInFlight.set(request.playbackId, pending);
    try {
      return await pending;
    } finally {
      if (this.playbackOutcomeInFlight.get(request.playbackId) === pending) {
        this.playbackOutcomeInFlight.delete(request.playbackId);
      }
    }
  }

  private async processPlaybackOutcome(request: PlaybackOutcomeRequest): Promise<{
    duplicate: boolean;
    learningReceipt?: LearningReceipt;
  }> {
    // Passive completion, abandonment, and playback failures are facts, not
    // user interaction. They must not keep a two-hour session intent alive.
    const listeningSessionId = this.listeningSessionId;
    if (!this.repo.recordPlaybackOutcome(request)) {
      return { duplicate: true };
    }
    try {
    const track = this.findTrack(request.trackId);
    if (!track) {
      return { duplicate: false };
    }
    const at = request.at ?? this.now().toISOString();
    const ratio = request.durationMs && request.durationMs > 0
      ? request.listenedMs / request.durationMs
      : undefined;
    const validCompletion = request.outcome === "completed" && (ratio === undefined || ratio >= 0.8);
    const eventType: PlayEvent["type"] = validCompletion
      ? "complete"
      : request.outcome === "skipped"
        ? "skip"
        : request.outcome === "playback_error"
          ? "playback_error"
          : "abandoned";
    this.repo.addPlayEvent({
      eventId: `outcome:${request.playbackId}`,
      type: eventType,
      trackId: request.trackId,
      at,
      playbackId: request.playbackId,
      ...(request.decisionId ? { decisionId: request.decisionId } : {}),
      listenedMs: request.listenedMs,
      ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      ...(track.recordingKey ? { recordingKey: track.recordingKey } : {}),
      ...(track.source ? { source: track.source } : {}),
      reason: request.outcome
    });
    const policyReceipt = this.listeningPolicy.observe({
      observationId: `outcome:${request.playbackId}`,
      kind: "playback_outcome",
      track,
      at,
      sessionId: listeningSessionId,
      ...(request.decisionId ? { decisionId: request.decisionId } : {}),
      outcome: request.outcome,
      listenedMs: request.listenedMs,
      ...(request.durationMs !== undefined ? { durationMs: request.durationMs } : {}),
      activeSkip: request.outcome === "skipped",
      dayPeriod: this.getEnvironment().dayPeriod
    });
    const beforeKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    await this.refreshTasteProfile();
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    policyReceipt.replacedQueueCount = [...beforeKeys].filter((trackKey) => !afterKeys.has(trackKey)).length;
    this.repo.saveLearningReceipt(policyReceipt);
    const learningReceipt = this.toLearningReceipt(policyReceipt);
    this.recordAdaptivePlaybackAudit(track);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return { duplicate: false, learningReceipt };
    } catch (error) {
      // The playback id is an idempotency claim. If any downstream learning or
      // replanning step fails, release it so the client's network retry can
      // finish the same observation instead of being mistaken for a success.
      this.repo.releasePlaybackOutcome(request.playbackId);
      throw error;
    }
  }

  async undoLearning(undoToken: string): Promise<LearningReceipt | undefined> {
    const receipt = this.listeningPolicy.undo(undoToken);
    if (!receipt) return undefined;
    const original = this.repo.loadListeningPolicyState().observations.find((observation) =>
      observation.observationId === receipt.observationId
    );
    if (original?.favoriteBefore !== undefined) {
      const trackKey = getTrackKey(original.track);
      this.repo.setTrackFavorite(trackKey, original.favoriteBefore, this.now().toISOString());
      if (this.state.track && getTrackKey(this.state.track) === trackKey) {
        this.state.isFavorite = original.favoriteBefore;
      }
    }
    if (original?.sessionIntentsBefore) {
      this.repo.clearSessionIntents();
      for (const intent of original.sessionIntentsBefore) {
        if (Date.parse(intent.expiresAt) > this.now().getTime()) this.repo.upsertSessionIntent(intent);
      }
      this.desiredMood = this.activeDesiredMood();
      const restoredIntent = this.repo.getActiveSessionIntents(this.now().toISOString())[0];
      this.wsHub.broadcast({
        event: "session_intent_updated",
        data: restoredIntent ?? { cleared: true }
      });
    }
    await this.refreshTasteProfile();
    const beforeKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    receipt.replacedQueueCount = [...beforeKeys].filter((trackKey) => !afterKeys.has(trackKey)).length;
    this.repo.saveLearningReceipt(receipt);
    const learningReceipt = this.toLearningReceipt(receipt, true);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return learningReceipt;
  }

  async mutateTasteSignal(request: TasteSignalMutationRequest): Promise<LearningReceipt | undefined> {
    const atMs = this.now().getTime();
    const activeSignals = this.listeningPolicy.profile().signals
      .filter((signal) => !signal.reversedAt)
      .filter((signal) => !signal.expiresAt || Date.parse(signal.expiresAt) > atMs);
    const signal = request.signalId
      ? activeSignals.find((entry) => entry.signalId === request.signalId)
      : undefined;
    const legacySignal = request.signalId?.startsWith("legacy:")
      ? this.legacyBaselineSignals().find((entry) => entry.id === request.signalId)
      : undefined;
    if (request.action !== "reset_automatic" && ((!signal && !legacySignal) || signal?.source === "manual")) {
      return undefined;
    }
    if (request.action === "reset_automatic" && !activeSignals.some((entry) => entry.source === "implicit")) {
      return undefined;
    }
    const beforeKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    const track = signal ? this.trackForPreferenceSignal(signal) : undefined;
    const legacyTrack = legacySignal
      ? this.repo.getTrackStats(5000).find((stat) => stat.track.recordingKey === legacySignal.key)?.track
      : undefined;
    const at = new Date().toISOString();
    const policyReceipt = legacySignal
      ? this.listeningPolicy.observe({
          observationId: `legacy-correction:${crypto.randomUUID()}`,
          kind: "explicit_feedback",
          track: legacyTrack ?? { id: "policy:legacy", title: legacySignal.label, artists: [] },
          at,
          scope: "long_term",
          structuredPreferences: [{
            targetType: "recording",
            targetKey: legacySignal.key,
            direction: request.action === "confirm"
              ? "positive"
              : request.action === "delete"
                ? "neutral"
                : "negative",
            strength: request.action === "delete"
              ? 0
              : request.action === "decrease"
                ? 0.25
                : request.action === "confirm"
                  ? 0.8
                  : 1,
            label: request.action === "delete"
              ? `你已删除旧基线：${legacySignal.label}`
              : request.action === "block"
                ? `你已屏蔽旧基线：${legacySignal.label}`
                : request.action === "decrease"
                  ? `你已降低旧基线：${legacySignal.label}`
                  : `你已确认旧基线：${legacySignal.label}`
          }]
        })
      : this.listeningPolicy.observe({
          observationId: `signal-correction:${crypto.randomUUID()}`,
          kind: "signal_correction",
          track: track ?? { id: "policy:profile", title: "音乐画像", artists: [] },
          at,
          scope: "long_term",
          correction: request.action,
          ...(request.signalId ? { targetSignalId: request.signalId } : {})
        });
    if (policyReceipt.changedSignals.length === 0) return undefined;
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    policyReceipt.replacedQueueCount = [...beforeKeys].filter((trackKey) => !afterKeys.has(trackKey)).length;
    this.repo.saveLearningReceipt(policyReceipt);
    const learningReceipt = this.toLearningReceipt(policyReceipt);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return learningReceipt;
  }

  private async observeStructuredLongTermPreference(
    request: string,
    constraints: ListeningConstraint[],
    current: Track | undefined
  ): Promise<LearningReceipt | undefined> {
    const globallyNegative = /少放|不要|别再|不喜欢|避开|屏蔽|降低|less|avoid|never/iu.test(request);
    const relevant = sanitizeListeningConstraints(constraints).filter((constraint) =>
      ["include", "avoid", "artist", "tag", "mood", "scene"].includes(constraint.kind)
    );
    const inferred = relevant.length > 0
      ? relevant
      : current && /歌手|艺人|artist/iu.test(request)
        ? current.artists.map((artist): ListeningConstraint => ({ kind: "artist", value: artist, scope: "long_term" }))
        : current
          ? inferTrackTags(current)
              .filter((tag) => ["mood", "style", "scene"].includes(tag.category))
              .slice(0, 3)
              .map((tag): ListeningConstraint => ({ kind: "tag", value: tag.value, scope: "long_term" }))
          : [];
    const structuredPreferences = [...new Map(inferred.map((constraint) => {
      const targetType = constraint.kind === "artist" ||
        (["include", "avoid"].includes(constraint.kind) && /歌手|艺人|artist/iu.test(request))
        ? "artist" as const
        : "tag" as const;
      const negative = globallyNegative || constraint.kind === "avoid";
      const targetKey = targetType === "artist" ? constraint.value.trim().toLowerCase() : constraint.value.trim();
      return [`${targetType}:${targetKey}`, {
        targetType,
        targetKey,
        direction: negative ? "negative" as const : "positive" as const,
        strength: negative && /不要再|别再|永远不|never/iu.test(request) ? 1 : negative ? 0.65 : 0.75,
        label: negative
          ? `你希望以后少放 ${constraint.value.trim()}`
          : `你希望以后多放 ${constraint.value.trim()}`
      }];
    })).values()];
    if (structuredPreferences.length === 0) return undefined;

    const beforeKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    const policyReceipt = this.listeningPolicy.observe({
      observationId: `long-term-preference:${crypto.randomUUID()}`,
      kind: "explicit_feedback",
      track: current ?? {
        id: "policy:long-term-preference",
        title: "长期音乐偏好",
        artists: structuredPreferences
          .filter((preference) => preference.targetType === "artist")
          .map((preference) => preference.targetKey)
      },
      at: new Date().toISOString(),
      sessionId: this.listeningSessionId,
      scope: "long_term",
      structuredPreferences
    });
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    policyReceipt.replacedQueueCount = [...beforeKeys].filter((trackKey) => !afterKeys.has(trackKey)).length;
    this.repo.saveLearningReceipt(policyReceipt);
    const learningReceipt = this.toLearningReceipt(policyReceipt);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return learningReceipt;
  }

  private async handleNaturalLearningControl(request: string): Promise<MusicCommandResult | undefined> {
    const asksUndo = /撤销|取消刚才.*学习|误触.*(?:跳过|反馈).*(?:不要学习|别学)|刚才.*(?:不要|别).*学|undo/iu.test(request);
    if (asksUndo) {
      const state = this.repo.loadListeningPolicyState();
      const observations = new Map(state.observations.map((observation) => [observation.observationId, observation]));
      const playbackOnly = /误触|跳过|播放结果/iu.test(request);
      const nowMs = this.now().getTime();
      const receipt = (state.receipts ?? [])
        .filter((candidate) => !candidate.undoneAt && Date.parse(candidate.undoExpiresAt) >= nowMs)
        .filter((candidate) => {
          if (!playbackOnly) return true;
          const observation = observations.get(candidate.observationId);
          return observation?.kind === "playback_outcome" && observation.outcome === "skipped";
        })
        .sort((left, right) =>
          Date.parse(observations.get(right.observationId)?.at ?? "") -
          Date.parse(observations.get(left.observationId)?.at ?? "")
        )[0];
      const learningReceipt = receipt ? await this.undoLearning(receipt.undoToken) : undefined;
      return learningReceipt
        ? {
            action: "update_long_term_preference",
            outcome: "executed",
            summary: learningReceipt.summary,
            now: this.state,
            learningReceipt
          }
        : {
            action: "update_long_term_preference",
            outcome: "failed",
            summary: "没有找到仍可撤销的学习记录。",
            now: this.state
          };
    }

    const correctionContext = /画像|自动|信号|学到|学习记录|偏好/iu.test(request);
    if (!correctionContext) return undefined;
    const action = /重置/iu.test(request)
      ? "reset_automatic" as const
      : /删除|移除/iu.test(request)
        ? "delete" as const
        : /屏蔽|完全不要/iu.test(request)
          ? "block" as const
          : /降低|减弱|少一点/iu.test(request)
            ? "decrease" as const
            : /确认|固定/iu.test(request)
              ? "confirm" as const
              : undefined;
    if (!action) return undefined;

    let signalId: string | undefined;
    if (action !== "reset_automatic") {
      const lowered = request.toLowerCase();
      const active = this.listeningPolicy.profile().signals
        .filter((signal) => signal.source !== "manual" && !signal.reversedAt)
        .filter((signal) => !signal.expiresAt || Date.parse(signal.expiresAt) > this.now().getTime())
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const matching = active.find((signal) =>
        lowered.includes(signal.targetKey.toLowerCase()) ||
        lowered.includes(signal.label.toLowerCase())
      );
      const automatic = /自动|学到/iu.test(request)
        ? active.find((signal) => signal.source === "implicit")
        : undefined;
      signalId = matching?.signalId ?? automatic?.signalId ?? active[0]?.signalId;
    }
    const learningReceipt = await this.mutateTasteSignal({
      action,
      ...(signalId ? { signalId } : {})
    });
    return learningReceipt
      ? {
          action: "update_long_term_preference",
          outcome: "executed",
          summary: learningReceipt.summary,
          now: this.state,
          learningReceipt
        }
      : {
          action: "update_long_term_preference",
          outcome: "failed",
          summary: action === "reset_automatic"
            ? "当前没有可重置的自动学习信号。"
            : "没有找到可以纠正的音乐画像信号。",
          now: this.state
        };
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
      const learningReceipt = await this.handleFeedback({ type: favorite ? "like" : "unlike", trackId });
      const taste = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
      return { favorite: this.repo.isTrackFavorite(trackId), taste, learningReceipt };
    }
    const taste = await this.refreshTasteProfile();
    const updatedPlan = await this.regenerateDailyPlan(true);
    if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
    if (this.state.track && getTrackKey(this.state.track) === trackKey) {
      this.state.isFavorite = favorite;
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    return { favorite: this.repo.isTrackFavorite(trackId), taste };
  }

  async handleChat(message: string, turnId?: string, preplanned?: import("@musicgpt/shared").MusicActionPlan): Promise<ChatResponse> {
    const model = this.aiDjAssistant.status().model;
    const effectiveTurnId = turnId?.trim() || `text_${crypto.randomUUID()}`;
    return this.conversation.respondText(
      {
        message,
        now: this.state,
        turnId: effectiveTurnId,
        ...(model ? { model } : {})
      },
      async () => {
        const command = await this.executeMusicCommand({
          turnId: effectiveTurnId,
          commandId: `text:${effectiveTurnId}`,
          request: message,
          mode: "text_suggest"
        }, preplanned);
        return {
          action: command.action,
          reply: command.summary,
          now: command.now,
          command,
          ...(command.suggestion ? { trackSuggestion: command.suggestion } : {}),
          ...(command.learningReceipt ? { learningReceipt: command.learningReceipt } : {}),
          ...(command.clarification ? { clarification: command.clarification } : {})
        };
      }
    );
  }

  async handleChatStream(
    message: string,
    callbacks: ChatStreamCallbacks,
    turnId?: string
  ): Promise<ChatResponse> {
    const streamChat = this.aiDjAssistant.streamChat?.bind(this.aiDjAssistant);
    const context = this.buildAiContext(message);
    let ordinaryChat = false;
    let preplanned: import("@musicgpt/shared").MusicActionPlan | undefined;
    if (streamChat) {
      try {
        if (this.aiDjAssistant.plan) {
          const plan = await this.aiDjAssistant.plan(message, context);
          preplanned = plan;
          ordinaryChat =
            plan.confidence >= 0.75 &&
            !plan.clarification &&
            plan.actions.length > 0 &&
            plan.actions.every((action) => action.action === "noop" && (action.confidence ?? 1) >= 0.75);
        } else {
          ordinaryChat = (await this.classifySafely(message, context)).type === "chat";
        }
      } catch {
        ordinaryChat = false;
      }
    }
    if (!streamChat || !ordinaryChat) {
      const response = await this.handleChat(message, turnId, preplanned);
      callbacks.onTextDelta(response.reply);
      callbacks.onResult(response);
      return response;
    }

    const effectiveTurnId = turnId?.trim() || `text_${crypto.randomUUID()}`;
    const model = this.aiDjAssistant.status().model;
    const input = {
      message,
      now: this.state,
      turnId: effectiveTurnId,
      ...(model ? { model } : {})
    };
    let response: ChatResponse;
    try {
      response = await this.conversation.respondText(input, async () => ({
        action: "noop",
        reply: await streamChat(message, context, callbacks.onTextDelta),
        now: this.state
      }));
    } catch {
      response = await this.conversation.respondText(input, async () => ({
        action: "noop",
        reply: AI_OPEN_ENDED_REPLY_FAILED,
        now: this.state
      }));
      callbacks.onTextDelta(AI_OPEN_ENDED_REPLY_FAILED);
    }
    callbacks.onResult(response);
    return response;
  }

  private async handleStructuredAction(
    request: string,
    action: MusicActionStep,
    constraints: ListeningConstraint[]
  ): Promise<MusicCommandResult> {
    if (
      (action.action === "update_session_intent" || action.action === "update_long_term_preference") &&
      containsSensitivePreference([
        request,
        action.desiredMood,
        action.description,
        ...constraints.map((constraint) => constraint.value)
      ])
    ) {
      return {
        action: action.action,
        outcome: "failed",
        summary: "这段内容可能包含敏感信息，不会写入音乐画像或临时意图。",
        now: this.state
      };
    }
    if (action.action === "update_long_term_preference") {
      const learningControl = await this.handleNaturalLearningControl(request);
      if (learningControl) return learningControl;
    }
    if (action.feedbackReason) {
      const target = this.findReferencedTrack(action);
      if (!target) {
        return {
          action: action.action,
          outcome: "failed",
          summary: "没有找到你指的那首歌。",
          now: this.state
        };
      }
      const learningReceipt = await this.handleFeedback({
        type: "teach",
        trackId: getTrackKey(target),
        reason: action.feedbackReason,
        scope: action.scope ?? (["wrong_for_now", "bad_version", "playback_problem"].includes(action.feedbackReason) ? "session" : "long_term"),
        ...(this.state.playbackId && this.state.track && getTrackKey(this.state.track) === getTrackKey(target)
          ? { playbackId: this.state.playbackId }
          : {}),
        ...(this.state.decision?.decisionId ? { decisionId: this.state.decision.decisionId } : {})
      });
      return {
        action: action.action,
        outcome: "executed",
        summary: learningReceipt.summary,
        now: this.state,
        learningReceipt
      };
    }
    if (action.action === "update_long_term_preference") {
      const current = this.state.track;
      const reason = /听腻|腻了|overplayed/iu.test(request)
        ? "overplayed"
        : /版本|播放.*问题|版权/iu.test(request)
          ? "bad_version"
          : undefined;
      let learningReceipt: LearningReceipt | undefined;
      if (reason && current) {
        learningReceipt = await this.handleFeedback({
          type: "teach",
          trackId: getTrackKey(current),
          reason,
          scope: reason === "bad_version" ? "session" : "long_term",
          ...(this.state.playbackId ? { playbackId: this.state.playbackId } : {}),
          ...(this.state.decision?.decisionId ? { decisionId: this.state.decision.decisionId } : {})
        });
      } else {
        learningReceipt = await this.observeStructuredLongTermPreference(request, constraints, current);
      }
      if (!learningReceipt) {
        return {
          action: action.action,
          outcome: "failed",
          summary: "还不能确定这条长期偏好指向哪个艺人或音乐特征。",
          now: this.state
        };
      }
      return {
        action: action.action,
        outcome: "executed",
        summary: learningReceipt.summary,
        now: this.state,
        learningReceipt
      };
    }

    const safeConstraints = sanitizeListeningConstraints(constraints).filter((constraint) =>
      ["include", "avoid", "artist", "tag", "mood", "scene"].includes(constraint.kind)
    );
    const positiveConstraint = safeConstraints.find((constraint) =>
      constraint.kind !== "avoid" &&
      (constraint.kind === "include" || constraint.kind === "mood" || constraint.kind === "scene" || constraint.kind === "tag")
    );
    const desiredMood = sanitizePreferenceText(action.desiredMood) ||
      positiveConstraint?.value ||
      safeConstraints[0]?.value ||
      sanitizePreferenceText(action.description);
    if (!desiredMood) {
      return {
        action: action.action,
        outcome: "failed",
        summary: "还缺少要调整成的氛围或场景。",
        now: this.state
      };
    }
    const scope: SessionIntent["scope"] = action.scope === "day" ? "day" : "session";
    const at = this.now();
    const globallyNegative = /少放|不要|别放|别再|不喜欢|避开|屏蔽|降低|less|avoid|never/iu.test(request);
    const effectiveConstraints = safeConstraints.length > 0
      ? safeConstraints
      : [{
          kind: globallyNegative ? "avoid" as const : "include" as const,
          value: desiredMood,
          scope
        }];
    const structuredPreferences = [...new Map(effectiveConstraints.map((constraint) => {
      const targetType = constraint.kind === "artist" ? "artist" as const : "tag" as const;
      const negative = constraint.kind === "avoid" || (effectiveConstraints.length === 1 && globallyNegative);
      const targetKey = targetType === "artist" ? constraint.value.toLowerCase() : constraint.value;
      return [`${targetType}:${targetKey}`, {
        targetType,
        targetKey,
        direction: negative ? "negative" as const : "positive" as const,
        strength: constraint.hard ? 1 : negative ? 0.65 : 0.75,
        label: negative
          ? `当前${scope === "day" ? "今天" : "会话"}避开 ${constraint.value}`
          : `当前${scope === "day" ? "今天" : "会话"}偏向 ${constraint.value}`
      }];
    })).values()];
    const direction: NonNullable<SessionIntent["direction"]> = structuredPreferences.some((preference) =>
      preference.direction === "positive" && preference.targetKey === desiredMood
    ) ? "include" : structuredPreferences.every((preference) => preference.direction === "negative") ? "avoid" : "include";
    const intentsBefore = this.repo.getActiveSessionIntents(at.toISOString());
    const intent: SessionIntent = {
      intentId: scope === "day"
        ? `day:${localDateKeyForTimezone(at, this.timezone)}`
        : `session:${this.listeningSessionId}`,
      value: desiredMood,
      direction,
      constraints: effectiveConstraints,
      scope,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      expiresAt: scope === "day"
        ? endOfDayInTimezone(at, this.timezone).toISOString()
        : new Date(at.getTime() + 2 * 60 * 60_000).toISOString(),
      sessionId: this.listeningSessionId
    };
    this.repo.clearSessionIntents();
    this.repo.upsertSessionIntent(intent);
    this.desiredMood = direction === "include" ? desiredMood : undefined;
    this.wsHub.broadcast({ event: "session_intent_updated", data: intent });

    const beforeKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    const policyReceipt = this.listeningPolicy.observe({
      observationId: `session-intent:${crypto.randomUUID()}`,
      kind: "explicit_feedback",
      track: this.state.track ?? {
        id: "policy:session-intent",
        title: "临时音乐意图",
        artists: structuredPreferences
          .filter((preference) => preference.targetType === "artist")
          .map((preference) => preference.targetKey)
      },
      at: at.toISOString(),
      sessionId: this.listeningSessionId,
      scope,
      structuredPreferences,
      sessionIntentsBefore: intentsBefore,
      sessionIntentAfter: intent
    });

    const immediate = action.immediate ??
      (/换成|切到|来点|马上|现在就|play now|switch/iu.test(request) && !/接下来|后面|之后/iu.test(request));
    let now = this.state;
    if (immediate) {
      await this.finalizeCurrentPlaybackAsSkipped();
      now = await this.nextTrack(true);
    } else {
      const updatedPlan = await this.regenerateDailyPlan(true);
      if (updatedPlan) this.state.queue = rollingWindow(updatedPlan, this.now(), QUEUE_TARGET_SIZE);
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
    }
    const afterKeys = new Set(this.state.queue.map((item) => getTrackKey(item.track)));
    policyReceipt.replacedQueueCount = [...beforeKeys].filter((trackKey) => !afterKeys.has(trackKey)).length;
    policyReceipt.summary = direction === "avoid"
      ? `已记住：${scope === "day" ? "今天" : "当前会话"}避开“${desiredMood}”`
      : `已记住：${scope === "day" ? "今天" : "当前会话"}偏向“${desiredMood}”`;
    this.repo.saveLearningReceipt(policyReceipt);
    const learningReceipt = this.toLearningReceipt(policyReceipt);
    this.wsHub.broadcast({ event: "learning_receipt", data: learningReceipt });
    return {
      action: action.action,
      outcome: "executed",
      summary: `${policyReceipt.summary}；${immediate
        ? "已立即切换歌曲。"
        : `当前这首继续播放，后续替换了 ${policyReceipt.replacedQueueCount} 首。`}`,
      now,
      learningReceipt
    };
  }

  private async handleChatIntent(
    message: string,
    context: AiDjContext,
    intent: AiDjIntent,
    constraints: ListeningConstraint[] = []
  ): Promise<ChatResponse> {
    switch (intent.type) {
      case "skip": {
        if (constraints.some((constraint) => constraint.hard)) {
          const description = constraints.map((constraint) => `${constraint.kind === "avoid" ? "不要" : ""}${constraint.value}`).join("，");
          const response = await this.suggestByDescription({ type: "play_by_description", description }, context, constraints);
          const suggestion = response.messages[0]?.trackSuggestion;
          if (!suggestion) return response;
          return this.reply("skip", `已按要求切到《${suggestion.track.title}》。`,
            await this.playSuggestedTrack(suggestion.track, suggestion.reason, suggestion.planItem));
        }
        const learningReceipt = await this.finalizeCurrentPlaybackAsSkipped();
        const response = this.reply("skip", "已切到下一首。", await this.nextTrack());
        return learningReceipt ? { ...response, learningReceipt } : response;
      }
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
        await this.handleStructuredAction(message, {
          action: "replan",
          desiredMood: intent.desiredMood,
          immediate: true,
          confidence: 0.9
        }, []);
        return this.reply("replan", `已切换为 ${intent.desiredMood} 风格。`, this.state);
      case "comment_current":
        return this.commentCurrentTrack(context);
      case "play_specific":
        return this.suggestSpecific(intent);
      case "play_by_description":
        return this.suggestByDescription(intent, context, constraints);
      case "play_atmosphere":
        return this.suggestAtmosphere(constraints);
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
    context: AiDjContext,
    constraints: ListeningConstraint[] = []
  ): Promise<ChatResponse> {
    const allowAmbient = isExplicitAmbientRequest(
      `${intent.description} ${intent.searchQuery ?? ""}`
    );
    const local = this.findLocalCandidates(intent.description, allowAmbient);
    const localKeys = new Set(local.map((candidate) => getTrackKey(candidate.track)));
    const localStats = this.repo
      .getTrackStats(800)
      .filter((entry) => localKeys.has(getTrackKey(entry.track)));
    const storedCandidates = this.repo
      .getRecommendationCandidates(300)
      .filter((candidate) => localKeys.has(getTrackKey(candidate.track)));
    const bestLocalScore = local[0]?.score ?? 0;
    let searchedRemotely = false;
    let remote: Track[] = [];
    const searchRemote = async (): Promise<void> => {
      searchedRemotely = true;
      const searchQuery = intent.searchQuery?.trim() || intent.description;
      remote = (await (this.catalog?.search(searchQuery) ?? this.ncm.searchSongs(searchQuery)).catch(() => []))
        .filter((track) => isEligibleRecommendationTrack(track, allowAmbient));
    };
    if (bestLocalScore < 0.35) {
      await searchRemote();
    }

    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const environment = context.environment ?? this.getEnvironment();
    const contextTags = dedupeMusicTags([
      ...this.buildRecommendationContextTags(),
      ...tagsFromContextText(intent.description)
    ]);
    const buildPlan = () => this.planContextualRecommendations({
      profile,
      environment,
      stats: localStats,
      candidates: mergeRecommendationCandidates(
        storedCandidates,
        contextSearchCandidates(remote, intent.description)
      ),
      contextTags,
      desiredMood: intent.description,
      constraints,
      allowAmbient,
      windowSize: 12
    });
    let plan = buildPlan();
    if (plan.length === 0 && !searchedRemotely) {
      await searchRemote();
      plan = buildPlan();
    }
    const candidates = plan.map((item) => item.track);
    if (plan.length === 0) {
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

    const planItem = plan.find((item) => getTrackKey(item.track) === getTrackKey(target));
    const reason = descriptionEvidence(intent.description, target);
    return this.reply(
      "play_by_description",
      `${reason}，选了《${target.title}》— ${formatArtists(target)}。`,
      this.state,
      this.createTrackSuggestion(target, reason, planItem)
    );
  }

  private async suggestAtmosphere(constraints: ListeningConstraint[] = []): Promise<ChatResponse> {
    const environment = await this.refreshEnvironmentIfNeeded();
    await this.refreshRecommendationCandidates().catch(() => undefined);
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const context = this.buildAiContext();
    const description = this.atmosphereDescription(environment);
    const desiredMood = this.activeDesiredMood();
    const plan = this.planContextualRecommendations({
      profile,
      environment,
      constraints,
      candidates: this.repo.getRecommendationCandidates(),
      contextTags: dedupeMusicTags([
        ...this.buildRecommendationContextTags(),
        ...tagsFromContextText(description)
      ]),
      ...(desiredMood ? { desiredMood } : {}),
      windowSize: 12
    });
    const candidates = plan.map((item) => item.track);
    if (candidates.length === 0) {
      return this.reply(
        "noop",
        "候选曲库尚未准备好；同步网易云后可再次使用氛围点歌。",
        this.state
      );
    }
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
      desiredMood
    );
    return this.reply(
      "play_atmosphere",
      `${reason}，选了《${target.title}》— ${formatArtists(target)}。`,
      this.state,
      this.createTrackSuggestion(target, reason, planItem)
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

  private planContextualRecommendations(input: ContextualPlanInput): RadioPlanItem[] {
    const period = input.environment.dayPeriod;
    const rules = this.tasteDocuments?.readRules().rules ?? {
      artistWeights: {},
      tagWeights: {},
      blockedArtists: [],
      blockedTags: []
    };
    return this.planner.plan(
      input.stats ?? this.repo.getTrackStats(),
      input.profile,
      this.getRecommendationFeedbackEvents(),
      {
        ...(input.windowSize !== undefined ? { windowSize: input.windowSize } : {}),
        environment: input.environment,
        ...(input.candidates ? { candidates: input.candidates } : {}),
        ...(input.contextTags ? { contextTags: input.contextTags } : {}),
        ...(input.desiredMood ? { desiredMood: input.desiredMood } : {}),
        constraints: [...this.activeListeningConstraints(), ...(input.constraints ?? [])],
        ...(input.allowAmbient !== undefined ? { allowAmbient: input.allowAmbient } : {}),
        rules,
        sessionId: this.listeningSessionId,
        policyMode: this.intelligencePolicy.mode(),
        onPolicyError: () => {
          this.intelligencePolicy.recordRankingFailure();
          this.shadowRankings.delete(period);
        },
        onShadowRanking: (decisions: RankedDecision[]) => {
          this.shadowRankings.set(period, decisions);
        }
      }
    );
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
    const desiredMood = this.activeDesiredMood();
    const tags = [
      ...environmentTags(this.getEnvironment()),
      ...tagsFromContextText(this.recentUserContextText())
    ];
    if (desiredMood) {
      tags.push({ category: "mood" as const, value: desiredMood });
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
    const desiredMood = this.activeDesiredMood();
    const parts = [
      environment.weather === "unknown" ? undefined : weatherLabel(environment.weather),
      periodLabel(environment.dayPeriod),
      ...tagsFromContextText(this.recentUserContextText())
        .filter((tag) => tag.category === "scene" || tag.category === "style")
        .slice(0, 3)
        .map((tag) => tag.value),
      desiredMood
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
    const status = await this.getSystemStatus();
    this.wsHub.broadcast({ event: "system_status", data: status });
    this.wsHub.broadcast({ event: "policy_status", data: status.intelligencePolicy });
  }

  private async finalizeCurrentPlaybackAsSkipped(): Promise<LearningReceipt | undefined> {
    const track = this.state.track;
    const playbackId = this.state.playbackId;
    if (!track || !playbackId) return undefined;
    const startedAt = this.state.startedAt ? Date.parse(this.state.startedAt) : Number.NaN;
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    const listenedMs = track.durationMs && track.durationMs > 0
      ? Math.min(track.durationMs, elapsedMs)
      : elapsedMs;
    const result = await this.handlePlaybackOutcome({
      playbackId,
      trackId: getTrackKey(track),
      outcome: "skipped",
      listenedMs,
      ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {})
    });
    return result.learningReceipt;
  }

  private getRecommendationFeedbackEvents(): PlayEvent[] {
    return this.repo.getPlayEventsSince(
      new Date(Date.now() - RECOMMENDATION_FEEDBACK_WINDOW_MS).toISOString()
    );
  }

  private async regenerateDailyPlan(force: boolean): Promise<DailyPlan | undefined> {
    if (!this.dailyPlanEngine || !this.routineProvider || !this.tasteDocuments) return undefined;
    const at = this.now();
    const date = localDateKeyForTimezone(at, this.timezone);
    const previous = this.repo.getDailyPlan();
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const parsed = this.tasteDocuments.readRules();
    const timeline = await this.environmentService.getTimeline?.(date, this.timezone).catch(() => undefined);
    this.repo.expireSessionIntents(at.toISOString());
    const sessionIntent = this.repo.getActiveSessionIntents(at.toISOString()).find((intent) =>
      intent.scope === "day" || !intent.sessionId || intent.sessionId === this.listeningSessionId
    );
    const desiredMood = this.activeDesiredMood(at);
    const next = this.dailyPlanEngine.generate({
      date,
      timezone: this.timezone,
      stats: this.repo.getTrackStats(5000),
      profile,
      rules: parsed.rules,
      routine: this.routineProvider.getBlocks(date, this.timezone),
      weather: this.getEnvironment(),
      feedback: this.getRecommendationFeedbackEvents(),
      candidates: this.repo.getRecommendationCandidates(),
      ...(desiredMood ? { desiredMood } : {}),
      ...(sessionIntent ? { sessionIntent } : {}),
      sessionId: this.listeningSessionId,
      policyMode: this.intelligencePolicy.mode(),
      onPolicyError: () => {
        this.intelligencePolicy.recordRankingFailure();
        this.shadowRankings.clear();
      },
      onShadowRanking: (period, decisions) => {
        this.shadowRankings.set(period, decisions);
      },
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

  private findTrack(trackId: TrackReference): Track | undefined {
    const trackKey = normalizeTrackReference(trackId);
    if (this.state.track && getTrackKey(this.state.track) === trackKey) return this.state.track;
    const queued = this.state.queue.find((item) => getTrackKey(item.track) === trackKey)?.track;
    if (queued) return queued;
    return this.repo.getTrackStats(5000).find((stat) => getTrackKey(stat.track) === trackKey)?.track;
  }

  private trackForPreferenceSignal(signal: PreferenceSignal): Track | undefined {
    const tracks = [
      ...(this.state.track ? [this.state.track] : []),
      ...this.state.queue.map((item) => item.track),
      ...this.repo.getTrackStats(5000).map((stat) => stat.track)
    ];
    if (signal.targetType === "version") {
      return tracks.find((track) => getTrackKey(track) === signal.targetKey);
    }
    if (signal.targetType === "recording") {
      return tracks.find((track) => track.recordingKey === signal.targetKey);
    }
    if (signal.targetType === "artist") {
      return tracks.find((track) => track.artists.some((artist) => artist.toLowerCase() === signal.targetKey.toLowerCase()));
    }
    return undefined;
  }

  private findReferencedTrack(action: MusicActionStep): Track | undefined {
    const reference = action.reference;
    if (!reference || reference.kind === "current") return this.state.track;
    if (reference.kind === "queue") return this.state.queue[(reference.index ?? 1) - 1]?.track;
    if (reference.kind === "track" && reference.trackId !== undefined) return this.findTrack(reference.trackId);
    if (reference.kind === "recent") {
      const trackKeys = [...new Set(
        this.repo.getRecentPlayEvents(200)
          .filter((event) => event.type === "play_start" || event.type === "play")
          .map((event) => normalizeTrackReference(event.trackId))
      )];
      const trackKey = trackKeys[(reference.index ?? 1) - 1];
      return trackKey ? this.findTrack(trackKey) : undefined;
    }
    return undefined;
  }

  /**
   * A listening session follows actual interaction, not process lifetime. An
   * active session-scoped intent is extended while the listener is active and
   * a fresh id is issued after two hours of silence.
   */
  private beginListeningInteraction(at = this.now()): string {
    const timestamp = at.getTime();
    const idleMs = this.lastListeningInteractionAt > 0
      ? timestamp - this.lastListeningInteractionAt
      : 0;
    if (this.lastListeningInteractionAt > 0 && idleMs >= 2 * 60 * 60_000) {
      this.listeningSessionId = crypto.randomUUID();
    }
    this.lastListeningInteractionAt = timestamp;
    const sessionExpiresAt = new Date(timestamp + 2 * 60 * 60_000).toISOString();
    this.repo.saveListeningSessionState({
      sessionId: this.listeningSessionId,
      lastInteractionAt: at.toISOString()
    });
    this.repo.expireSessionIntents(at.toISOString());
    for (const intent of this.repo.getActiveSessionIntents(at.toISOString())) {
      if (intent.scope !== "session" || intent.sessionId !== this.listeningSessionId) continue;
      this.repo.upsertSessionIntent({
        ...intent,
        updatedAt: at.toISOString(),
        expiresAt: sessionExpiresAt
      });
    }
    this.listeningPolicy.extendSession(this.listeningSessionId, sessionExpiresAt, at.toISOString());
    this.activeDesiredMood(at);
    return this.listeningSessionId;
  }

  private activeDesiredMood(at = this.now()): string | undefined {
    this.repo.expireSessionIntents(at.toISOString());
    const active = this.repo.getActiveSessionIntents(at.toISOString()).find((intent) =>
      intent.scope === "day" || !intent.sessionId || intent.sessionId === this.listeningSessionId
    );
    this.desiredMood = active?.direction === "avoid" ? undefined : active?.value;
    return this.desiredMood;
  }

  private activeListeningConstraints(): ListeningConstraint[] {
    return this.repo.getActiveSessionIntents(this.now().toISOString())
      .filter((intent) => intent.scope === "day" || !intent.sessionId || intent.sessionId === this.listeningSessionId)
      .flatMap((intent) => intent.constraints ?? []);
  }

  private toLearningReceipt(receipt: PolicyLearningReceipt, undo = false): LearningReceipt {
    const policyMode = this.intelligencePolicy.mode();
    const appliedMode: LearningReceipt["appliedMode"] = policyMode === "adaptive"
      ? "active"
      : policyMode === "shadow"
        ? "shadow_only"
        : "legacy_only";
    return {
      receiptId: receipt.receiptId,
      scope: receipt.scope,
      changedSignals: receipt.changedSignals.map((signal) => ({
        signalId: signal.signalId,
        dimension: policySignalDimension(signal),
        key: signal.targetKey,
        label: signal.label,
        operation: receipt.operations?.[signal.signalId] ??
          (undo ? (signal.reversedAt ? "removed" : "updated") : "added"),
        weight: signedSignalWeight(signal),
        source: policySignalSource(signal)
      })),
      replacedQueueCount: receipt.replacedQueueCount,
      summary: undo ? `已撤销：${receipt.summary}` : receipt.summary,
      undoToken: receipt.undoToken,
      undoExpiresAt: undo ? (receipt.undoneAt ?? this.now().toISOString()) : receipt.undoExpiresAt,
      appliedMode
    };
  }

  private noopLearningReceipt(
    scope: LearningReceipt["scope"],
    replacedQueueCount: number,
    summary: string
  ): LearningReceipt {
    return {
      receiptId: crypto.randomUUID(),
      scope,
      changedSignals: [],
      replacedQueueCount,
      summary,
      undoToken: crypto.randomUUID(),
      undoExpiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString(),
      appliedMode: this.intelligencePolicy.mode() === "adaptive"
        ? "active"
        : this.intelligencePolicy.mode() === "shadow"
          ? "shadow_only"
          : "legacy_only"
    };
  }

  private recordShadowRecommendationAudit(period: string): void {
    if (this.intelligencePolicy.mode() !== "shadow") return;
    const decisions = this.shadowRankings.get(period) ?? [];
    const proposed = decisions[0];
    const rules = this.tasteDocuments?.readRules().rules ?? {
      artistWeights: {},
      tagWeights: {},
      blockedArtists: [],
      blockedTags: []
    };
    const duplicateRecordings = decisions
      .slice(0, QUEUE_TARGET_SIZE)
      .reduce((state, decision) => {
        state.counts.set(decision.recordingKey, (state.counts.get(decision.recordingKey) ?? 0) + 1);
        return state;
      }, { counts: new Map<string, number>() })
      .counts;
    const duplicateCount = [...duplicateRecordings.values()]
      .reduce((total, count) => total + Math.max(0, count - 1), 0);
    const quotas = this.listeningPolicy.profile().quotas;
    const quotaGuardrailSatisfied = Object.entries(DAILY_PLAN_QUOTA_GUARDS).every(([key, guard]) => {
      const value = quotas[key as keyof typeof quotas];
      return value >= guard.min && value <= guard.max;
    });
    const desiredMood = this.activeDesiredMood();
    const activeIntent = this.repo.getActiveSessionIntents(this.now().toISOString()).find((intent) =>
      intent.scope === "day" || !intent.sessionId || intent.sessionId === this.listeningSessionId
    );
    const hasExplicitConstraint = Boolean(
      desiredMood || activeIntent?.constraints?.some((constraint) => constraint.hard)
    );
    this.intelligencePolicy.recordShadowDecision({
      manualRuleViolations: proposed && isTrackBlockedByManualRules(proposed.track, rules) ? 1 : 0,
      duplicateRecordings: duplicateCount,
      quotaGuardrailSatisfied,
      explicitConstraintsSatisfied: !hasExplicitConstraint || Boolean(
        proposed && trackSatisfiesListeningIntent(proposed.track, activeIntent, desiredMood)
      ),
      exceptional: !proposed
    });
    void this.broadcastSystemStatus();
  }

  private recordAdaptivePlaybackAudit(track: Track): void {
    if (this.intelligencePolicy.mode() !== "adaptive") return;
    const events = this.repo.getPlayEventsSince(
      new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
    ).filter((event) => ["complete", "skip", "abandoned", "playback_error"].includes(event.type));
    const recent = events.slice(0, 50);
    const baseline = events.slice(50);
    const earlySkipRate = rate(recent, isEarlySkipEvent);
    const baselineEarlySkipRate = baseline.length > 0 ? rate(baseline, isEarlySkipEvent) : earlySkipRate;
    const rules = this.tasteDocuments?.readRules().rules ?? {
      artistWeights: {},
      tagWeights: {},
      blockedArtists: [],
      blockedTags: []
    };
    this.intelligencePolicy.recordAdaptivePlayback({
      manualRuleViolation: isTrackBlockedByManualRules(track, rules),
      playbackErrorRate: rate(recent, (event) => event.type === "playback_error"),
      earlySkipRate,
      baselineEarlySkipRate
    });
    void this.broadcastSystemStatus();
  }

  private toTasteSignal(signal: PreferenceSignal, sessionCount = 0): TasteSignal {
    return {
      id: signal.signalId,
      dimension: policySignalDimension(signal),
      key: signal.targetKey,
      label: signal.label,
      weight: signedSignalWeight(signal),
      confidence:
        signal.source === "manual"
          ? 1
          : signal.source === "explicit"
            ? 0.9
            : signal.source === "implicit"
              ? Math.min(0.75, 0.35 + signal.observationIds.length * 0.1)
              : 0.35,
      source: policySignalSource(signal),
      scope: signal.scope,
      evidenceCount: signal.observationIds.length,
      sessionCount,
      updatedAt: signal.updatedAt,
      ...(signal.expiresAt ? { expiresAt: signal.expiresAt } : {}),
      ...(signal.source === "manual" ? { locked: true } : {})
    };
  }

  private legacyBaselineSignals(): TasteSignal[] {
    const byRecording = new Map<string, TasteSignal>();
    const deletedRecordings = new Set(this.listeningPolicy.profile().signals
      .filter((signal) =>
        !signal.reversedAt &&
        signal.source === "explicit" &&
        signal.targetType === "recording" &&
        signal.label.startsWith("你已删除旧基线：")
      )
      .map((signal) => signal.targetKey));
    for (const stat of this.repo.getTrackStats(5000)) {
      const key = stat.track.recordingKey ?? getTrackKey(stat.track);
      if (deletedRecordings.has(key)) continue;
      const confidence = stat.localFavoritedAt
        ? 0.8
        : stat.likedAt
          ? 0.6
          : stat.playCount > 0
            ? 0.35
            : 0;
      if (confidence === 0) continue;
      const current = byRecording.get(key);
      if (current && current.confidence >= confidence) continue;
      byRecording.set(key, {
        id: `legacy:${key}`,
        dimension: "recording",
        key,
        label: stat.localFavoritedAt
          ? `本地收藏：${stat.track.title}`
          : stat.likedAt
            ? `平台喜欢：${stat.track.title}`
            : `既有播放记录：${stat.track.title}`,
        weight: confidence,
        confidence,
        source: "legacy",
        scope: "long_term",
        evidenceCount: Math.max(1, stat.playCount),
        sessionCount: 0,
        updatedAt: stat.localFavoritedAt ?? stat.likedAt ?? stat.lastPlayedAt ?? "1970-01-01T00:00:00.000Z"
      });
    }
    return [...byRecording.values()];
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

  private createTrackSuggestion(
    track: Track,
    reason: string,
    planItem?: RadioPlanItem
  ): TrackSuggestion {
    return {
      id: `suggestion_${track.id}_${Date.now()}`,
      track,
      reason,
      createdAt: new Date().toISOString(),
      ...(planItem ? { planItem } : {})
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
    const track = normalizeTrackIdentity(item.track);
    const recordingKey = track.recordingKey ?? getTrackKey(track);
    if (seen.has(recordingKey)) {
      continue;
    }
    seen.add(recordingKey);
    output.push(item);
  }
  return output;
}

const SENSITIVE_PREFERENCE_PATTERN =
  /(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|cookie|password|passwd|secret|bearer|密钥|密码|令牌|验证码|登录凭证|sk-[a-z0-9_-]{8,})/iu;
const CREDENTIAL_LIKE_TOKEN_PATTERN = /(?:^|\s)[a-z0-9_./+=-]{24,}(?:\s|$)/iu;

function containsSensitivePreference(values: Array<string | undefined>): boolean {
  return values.some((value) => {
    const trimmed = value?.trim();
    return Boolean(
      trimmed &&
      (SENSITIVE_PREFERENCE_PATTERN.test(trimmed) || CREDENTIAL_LIKE_TOKEN_PATTERN.test(trimmed))
    );
  });
}

function sanitizePreferenceText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  if (!trimmed || trimmed.length > 120 || containsSensitivePreference([trimmed])) return undefined;
  return trimmed;
}

function sanitizeListeningConstraints(constraints: ListeningConstraint[]): ListeningConstraint[] {
  return constraints.flatMap((constraint) => {
    const value = sanitizePreferenceText(constraint.value);
    return value ? [{ ...constraint, value }] : [];
  });
}

function contextSearchCandidates(tracks: Track[], description: string): RecommendationCandidate[] {
  const discoveredAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  const uniqueTracks = new Map(tracks.map((track) => [getTrackKey(track), track]));
  return [...uniqueTracks.values()].map((track) => {
    const tags = inferTrackTags(track);
    const normalized = normalizeTrackIdentity({ ...track, tags });
    return {
      track: normalized,
      source: "context_search",
      ...(normalized.source ? { provider: normalized.source } : {}),
      discovery: "context_search",
      tags,
      relevanceScore: Math.min(
        1,
        Math.max(0.65, scoreTrackForDescription({ track: normalized, playCount: 0 }, description))
      ),
      discoveredAt,
      expiresAt
    };
  });
}

function mergeRecommendationCandidates(
  ...groups: RecommendationCandidate[][]
): RecommendationCandidate[] {
  const merged = new Map<string, RecommendationCandidate>();
  for (const candidate of groups.flat()) {
    const key = getTrackKey(candidate.track);
    const current = merged.get(key);
    if (!current || candidate.relevanceScore > current.relevanceScore) {
      merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

function dedupeMusicTags(tags: MusicTag[]): MusicTag[] {
  return [...new Map(tags.map((tag) => [
    `${tag.category}:${tag.value.toLowerCase()}`,
    tag
  ])).values()];
}

function policySignalDimension(signal: PreferenceSignal): TasteSignal["dimension"] {
  if (signal.targetType === "version") return "source_version";
  if (signal.targetType === "recording") return "recording";
  if (signal.targetType === "artist") return "artist";
  if (signal.targetType === "quota") return "quota";
  return "tag";
}

function policySignalSource(signal: PreferenceSignal): TasteSignal["source"] {
  if (signal.source === "manual") return "manual_rule";
  if (signal.source === "baseline") return "legacy";
  return signal.source;
}

function signedSignalWeight(signal: PreferenceSignal): number {
  if (signal.direction === "negative") return -signal.strength;
  if (signal.direction === "neutral") return 0;
  return signal.strength;
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

function endOfDayInTimezone(date: Date, timezone: string): Date {
  const [year, month, day] = localDateKeyForTimezone(date, timezone).split("-").map(Number) as [number, number, number];
  const nextLocalMidnightAsUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
  const offsetLabel = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "longOffset"
  }).formatToParts(new Date(nextLocalMidnightAsUtc)).find((part) => part.type === "timeZoneName")?.value;
  const match = offsetLabel?.match(/GMT([+-])(\d{2}):(\d{2})/u);
  const offsetMs = match
    ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000
    : timezone === "Asia/Shanghai"
      ? 8 * 60 * 60_000
      : 0;
  return new Date(nextLocalMidnightAsUtc - offsetMs);
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

function isTrackBlockedByManualRules(track: Track, rules: TasteManualRules): boolean {
  const blockedArtists = new Set(rules.blockedArtists.map((artist) => artist.trim().toLowerCase()));
  if (track.artists.some((artist) => blockedArtists.has(artist.trim().toLowerCase()))) return true;
  const blockedTags = new Set(rules.blockedTags.map((tag) => tag.trim().toLowerCase()));
  return inferTrackTags(track).some((tag) => {
    const value = tag.value.trim().toLowerCase();
    return blockedTags.has(value) || blockedTags.has(`${tag.category}:${value}`);
  });
}

function trackMatchesIntent(track: Track, intent: string): boolean {
  const requestedTags = tagsFromContextText(intent);
  const trackTags = new Set(inferTrackTags(track).flatMap((tag) => [
    tag.value.toLowerCase(),
    `${tag.category}:${tag.value}`.toLowerCase()
  ]));
  if (requestedTags.length > 0) {
    return requestedTags.some((tag) =>
      trackTags.has(tag.value.toLowerCase()) ||
      trackTags.has(`${tag.category}:${tag.value}`.toLowerCase())
    );
  }
  const searchable = `${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`.toLowerCase();
  const tokens = intent.toLowerCase().split(/[\s,，。！？!?、]+/u).filter((token) => token.length >= 2);
  return tokens.length === 0 || tokens.some((token) => searchable.includes(token));
}

function trackSatisfiesListeningIntent(
  track: Track,
  intent: SessionIntent | undefined,
  desiredMood: string | undefined
): boolean {
  for (const constraint of intent?.constraints ?? []) {
    if (!constraint.hard) continue;
    const matches = constraint.kind === "artist"
      ? track.artists.some((artist) => artist.trim().toLowerCase() === constraint.value.trim().toLowerCase())
      : trackMatchesIntent(track, constraint.value);
    const negative = constraint.kind === "avoid" || intent?.direction === "avoid";
    if (negative ? matches : !matches) return false;
  }
  return !desiredMood || trackMatchesIntent(track, desiredMood);
}

function rate<T>(values: T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

function isEarlySkipEvent(event: PlayEvent): boolean {
  if (event.type !== "skip") return false;
  if (event.listenedMs !== undefined && event.listenedMs <= 30_000) return true;
  return Boolean(
    event.listenedMs !== undefined &&
    event.durationMs !== undefined &&
    event.durationMs > 0 &&
    event.listenedMs / event.durationMs < 0.2
  );
}

function isOpenEndedFailureReply(reply: string): boolean {
  return (
    reply === AI_OPEN_ENDED_REPLY_UNCONFIGURED ||
    reply === AI_OPEN_ENDED_REPLY_FAILED ||
    reply === AI_COMMENT_REPLY_FAILED
  );
}
