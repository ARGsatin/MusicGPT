export type MoodTag =
  | "calm"
  | "focus"
  | "warm"
  | "night"
  | "energy"
  | "nostalgia"
  | "unknown";

export type MusicTagCategory =
  | "artist"
  | "mood"
  | "style"
  | "scene"
  | "period"
  | "weather"
  | "routine";

export type IntrinsicMusicTagCategory = "artist" | "mood" | "style" | "scene";

export type MusicSource = "ncm" | "qq";

export type TrackKey = string;

/** Bare numbers remain accepted for the v1 NCM compatibility window. */
export type TrackReference = TrackKey | number;

export interface MusicTag {
  category: MusicTagCategory;
  value: string;
}

export type TrackTagSource = "platform" | "playlist" | "rule" | "ai" | "manual";

export interface TrackTagEvidence extends MusicTag {
  category: IntrinsicMusicTagCategory;
  confidence: number;
  source: TrackTagSource;
}

export interface PreferenceTag extends MusicTag {
  weight: number;
  evidenceCount: number;
}

export type DayPeriod = "morning" | "afternoon" | "evening" | "late_night";

/**
 * `teach` records an explicit recommendation correction without changing the
 * independent favorite flag. `unlike` remains the backwards-compatible
 * explicit "remove from favorites" action.
 */
export type FeedbackType = "skip" | "like" | "unlike" | "replay" | "complete" | "teach";

export type PlayEventType =
  | FeedbackType
  | "play"
  | "impression"
  | "play_start"
  | "abandoned"
  | "playback_error";

export type FeedbackReason =
  | "dislike_track"
  | "less_this_artist"
  | "wrong_for_now"
  | "overplayed"
  | "bad_version"
  | "playback_problem";

export type LearningScope = "session" | "day" | "long_term";

export type PlaybackOutcome = "completed" | "skipped" | "abandoned" | "playback_error";

export type IntelligencePolicyMode = "legacy" | "shadow" | "adaptive";

export type WeatherKind = "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm" | "unknown";

export type DjTone = "lively" | "calm" | "professional";

export type VoiceGender = "female" | "male";

export interface Track {
  /** @deprecated Use trackKey. Kept while v1 clients still send numeric NCM IDs. */
  id: TrackReference;
  trackKey?: TrackKey;
  recordingKey?: string;
  source?: MusicSource;
  sourceId?: string;
  /** Provider media identifier when playback needs a key distinct from sourceId. */
  playbackId?: string;
  /** Provider identifier used by the lyrics endpoint when it differs from sourceId. */
  lyricsId?: string;
  /** Provider metadata indicating that playback may require an active subscription. */
  requiresSubscription?: boolean;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  songUrl?: string;
  moodTag?: MoodTag;
  tags?: MusicTag[];
  tagEvidence?: TrackTagEvidence[];
}

export interface TrackStat {
  track: Track;
  likedAt?: string;
  localFavoritedAt?: string;
  playCount: number;
  lastPlayedAt?: string;
  lastPlayedHour?: number;
}

export interface LyricLine {
  timeMs: number;
  text: string;
  translation?: string;
}

export interface TrackLyrics {
  trackId: TrackReference;
  pureMusic: boolean;
  lines: LyricLine[];
}

export interface TopArtist {
  name: string;
  weight: number;
}

export interface TasteProfile {
  generatedAt: string;
  summary: string;
  topArtists: TopArtist[];
  topTracks: Array<{
    id: TrackReference;
    title: string;
    playCount: number;
  }>;
  favoritePeriods: Array<{
    period: DayPeriod;
    weight: number;
  }>;
  moodWeights: Record<MoodTag, number>;
  preferenceTags: PreferenceTag[];
  pacingPreference: "gentle" | "balanced" | "dynamic";
}

export interface EnvironmentLocation {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface EnvironmentContext {
  dayPeriod: DayPeriod;
  weather: WeatherKind;
  temperature?: number;
  location?: EnvironmentLocation;
  updatedAt: string;
}

export interface EnvironmentForecastPoint {
  at: string;
  weather: WeatherKind;
  temperature?: number;
}

export interface EnvironmentTimeline {
  timezone: string;
  points: EnvironmentForecastPoint[];
  updatedAt: string;
}

export interface EnvironmentLocationRequest {
  latitude: number;
  longitude: number;
  label?: string;
}

export interface DjSettings {
  tone: DjTone;
  voiceGender: VoiceGender;
  voice: string;
}

export interface RecommendationImportResponse {
  importedCount: number;
  skippedCount: number;
  environment: EnvironmentContext;
  systemStatus: SystemStatus;
}

export interface RadioPlanItem {
  track: Track;
  score: number;
  reason: string;
  bucket?: RecommendationBucket;
  source?: RecommendationSource;
  decisionId?: string;
  evidence?: RecommendationEvidence[];
  policyVersion?: string;
}

export type RecommendationEvidenceType =
  | "manual_rule"
  | "explicit_preference"
  | "implicit_behavior"
  | "legacy_baseline"
  | "session_intent"
  | "context"
  | "history"
  | "novelty"
  | "source_availability";

export interface RecommendationEvidence {
  type: RecommendationEvidenceType;
  label: string;
  /** Normalized evidence strength. Consumers should render labels, not this raw value. */
  strength: number;
  correctable: boolean;
  signalId?: string;
}

export interface RecommendationDecision {
  decisionId: string;
  policyVersion: string;
  evidence: RecommendationEvidence[];
  summary?: string;
}

export type RecommendationBucket = "familiar" | "explore";

export type RecommendationSource =
  | "library"
  | "ncm_daily"
  | "context_search"
  | "style_search"
  | "chat_search";

export interface RecommendationCandidate {
  track: Track;
  source: RecommendationSource;
  provider?: MusicSource;
  discovery?: "library" | "daily" | "context_search" | "style_search" | "chat_search";
  tags: MusicTag[];
  relevanceScore: number;
  discoveredAt: string;
  expiresAt: string;
}

export interface PlayEvent {
  type: PlayEventType;
  trackId: TrackReference;
  at: string;
  eventId?: string;
  recordingKey?: string;
  source?: MusicSource;
  reason?: string;
  scope?: LearningScope;
  playbackId?: string;
  decisionId?: string;
  listenedMs?: number;
  durationMs?: number;
  turnId?: string;
  sessionId?: string;
  context?: Record<string, string | number | boolean>;
  metadata?: Record<string, string | number | boolean>;
}

export interface DjScript {
  id: string;
  text: string;
  reason: string;
  trackIds: TrackReference[];
  createdAt: string;
}

export interface NowPlayingState {
  track?: Track;
  lyrics?: TrackLyrics;
  queue: RadioPlanItem[];
  playbackId?: string;
  startedAt?: string;
  paused: boolean;
  isFavorite?: boolean;
  djScript?: DjScript;
  decision?: RecommendationDecision;
}

export interface ChatRequest {
  message: string;
  turnId?: string;
}

export type ConversationSource = "text" | "voice";
export type ConversationTurnStatus = "completed" | "interrupted" | "failed";

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  turnId?: string;
  source?: ConversationSource;
  status?: ConversationTurnStatus;
  model?: string;
  sessionId?: string;
  trackSuggestion?: TrackSuggestion;
}

export type ChatMemoryCategory = "preference" | "habit" | "background" | "relationship";

export interface ChatMemory {
  id: number;
  category: ChatMemoryCategory;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "result"; response: ChatResponse }
  | { type: "error"; message: string };

export interface TrackSuggestion {
  id: string;
  track: Track;
  reason: string;
  createdAt: string;
  planItem?: RadioPlanItem;
}

export type MusicAction =
    | "skip"
    | "pause"
    | "resume"
    | "replan"
    | "play_specific"
    | "play_by_description"
    | "play_atmosphere"
    | "comment_current"
    | "noop"
    | "replay"
    | "like"
    | "unlike"
    | "query_current"
    | "query_queue"
    | "update_session_intent"
    | "update_long_term_preference";

export interface ChatResponse {
  action: MusicAction;
  reply: string;
  now: NowPlayingState;
  messages: ChatMessage[];
  command?: MusicCommandResult;
  learningReceipt?: LearningReceipt;
  clarification?: MusicCommandClarification;
}

export type MusicCommandOutcome = "executed" | "answered" | "needs_confirmation" | "failed";

export interface TrackReferenceQuery {
  kind: "current" | "recent" | "queue" | "track";
  /** One-based natural-language index, for example "刚才第二首". */
  index?: number;
  trackId?: TrackReference;
  title?: string;
  artist?: string;
}

export interface ListeningConstraint {
  kind: "include" | "avoid" | "mood" | "scene" | "artist" | "tag" | "source";
  value: string;
  scope?: LearningScope;
  hard?: boolean;
}

export interface MusicActionStep {
  action: MusicAction;
  query?: string;
  searchQuery?: string;
  description?: string;
  desiredMood?: string;
  reference?: TrackReferenceQuery;
  feedbackReason?: FeedbackReason;
  scope?: LearningScope;
  immediate?: boolean;
  confidence?: number;
}

export interface MusicCommandClarification {
  question: string;
  candidates?: Track[];
}

export interface MusicActionPlan {
  actions: MusicActionStep[];
  constraints: ListeningConstraint[];
  references: TrackReferenceQuery[];
  confidence: number;
  clarification?: MusicCommandClarification;
}

export interface MusicCommandRequest {
  turnId: string;
  commandId: string;
  request: string;
  mode: "text_suggest" | "voice_direct";
  confirmationToken?: string;
  selectedTrackId?: TrackReference;
}

export interface MusicCommandResult {
  action: MusicAction;
  outcome: MusicCommandOutcome;
  summary: string;
  now: NowPlayingState;
  suggestion?: TrackSuggestion;
  candidates?: Track[];
  confirmationToken?: string;
  actions?: MusicCommandActionResult[];
  clarification?: MusicCommandClarification;
  learningReceipt?: LearningReceipt;
}

export interface MusicCommandActionResult {
  index: number;
  action: MusicAction;
  outcome: MusicCommandOutcome;
  summary: string;
  now: NowPlayingState;
  learningReceipt?: LearningReceipt;
}

export interface VoiceTurnStartRequest {
  sessionId: string;
  clientTurnId: string;
  transcript: string;
  at: string;
}

export interface VoiceTurnStartResponse {
  turnId: string;
  revision: number;
  messages: ChatMessage[];
}

export interface VoiceTurnCompleteRequest {
  transcript?: string;
  model: string;
  responseId?: string;
  status: ConversationTurnStatus;
  at: string;
}

export interface RealtimeContextResponse {
  sessionId: string;
  contextRevision: number;
  instructions: string;
  session: Record<string, unknown>;
}

export interface RealtimeSessionResponse {
  enabled: boolean;
  model: string;
  voice: string;
  session: Record<string, unknown>;
  sessionId: string;
  contextRevision: number;
  conversationMode: "unified" | "legacy";
}

export interface FeedbackRequest {
  type: FeedbackType;
  trackId: TrackReference;
  reason?: FeedbackReason;
  scope?: LearningScope;
  playbackId?: string;
  decisionId?: string;
  listenedMs?: number;
  durationMs?: number;
}

export interface PlaybackOutcomeRequest {
  /** Unique playback activation identifier; a final outcome is accepted once. */
  playbackId: string;
  trackId: TrackReference;
  decisionId?: string;
  outcome: PlaybackOutcome;
  listenedMs: number;
  durationMs?: number;
  at?: string;
}

export interface LearningUndoRequest {
  undoToken: string;
}

export type TasteSignalMutationAction =
  | "confirm"
  | "decrease"
  | "block"
  | "delete"
  | "reset_automatic";

export interface TasteSignalMutationRequest {
  action: TasteSignalMutationAction;
  signalId?: string;
}

export type TasteSignalSource = "manual_rule" | "explicit" | "implicit" | "legacy";
export type TasteSignalDimension = "recording" | "source_version" | "artist" | "tag" | "context" | "quota";

export interface TasteSignal {
  id: string;
  dimension: TasteSignalDimension;
  key: string;
  label: string;
  weight: number;
  confidence: number;
  source: TasteSignalSource;
  scope: LearningScope;
  evidenceCount: number;
  sessionCount: number;
  updatedAt: string;
  expiresAt?: string;
  locked?: boolean;
}

export interface LearningSignalChange {
  signalId?: string;
  dimension: TasteSignalDimension;
  key: string;
  label: string;
  operation: "added" | "updated" | "removed";
  weight: number;
  source: TasteSignalSource;
}

export interface LearningReceipt {
  receiptId: string;
  scope: LearningScope;
  changedSignals: LearningSignalChange[];
  replacedQueueCount: number;
  summary: string;
  undoToken: string;
  undoExpiresAt: string;
  /** Shadow mode records the fact but does not claim it affected live ranking. */
  appliedMode?: "active" | "shadow_only" | "legacy_only";
}

export interface SessionIntent {
  intentId: string;
  value: string;
  /** Whether this context should be sought or avoided by the pending plan. */
  direction?: "include" | "avoid";
  /** Sanitized structured constraints used to reproduce and explain ranking. */
  constraints?: ListeningConstraint[];
  scope: "session" | "day";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sessionId?: string;
  turnId?: string;
}

export type LibraryEvidenceKind =
  | "platform_like"
  | "playlist"
  | "recent_play"
  | "local_favorite";

export interface LibraryEvidence {
  recordingKey: string;
  trackKey: TrackKey;
  source: MusicSource;
  kind: LibraryEvidenceKind;
  observedAt: string;
  containerId?: string;
  containerName?: string;
  playCount?: number;
}

export interface MusicSourceStatus {
  source: MusicSource;
  enabled: boolean;
  connected: boolean;
  accountLabel?: string;
  lastSyncAt?: string;
  lastError?: string;
  capabilities?: {
    accountLibrary: boolean;
    recentPlays: boolean;
    search: boolean;
    recommendations: boolean;
    playback: boolean;
    lyrics: boolean;
  };
}

export interface MusicSourceSyncResponse {
  source: MusicSource;
  importedCount: number;
  evidenceCount: number;
  warnings: string[];
  status: MusicSourceStatus;
}

export interface QqAuthQrResponse {
  sessionId: string;
  imageDataUrl: string;
  expiresAt: string;
}

export interface QqAuthStatusResponse {
  sessionId: string;
  status: "pending" | "authorized" | "expired" | "error";
  message?: string;
}

export interface TasteManualRules {
  tagWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  blockedTags: string[];
  blockedArtists: string[];
}

export interface TasteDocumentStatus {
  path: string;
  updatedAt?: string;
  valid: boolean;
  error?: string;
  manualRules: TasteManualRules;
}

export interface TasteResponse extends TasteProfile {
  manualRules: TasteManualRules;
  document: TasteDocumentStatus;
  signals?: {
    explicit: TasteSignal[];
    implicit: TasteSignal[];
    legacy: TasteSignal[];
  };
}

export type RoutineEnergy = "low" | "medium" | "high";

export interface RoutineBlock {
  start: string;
  end: string;
  activity: string;
  tags: MusicTag[];
  energy: RoutineEnergy;
  musicAllowed: boolean;
}

export interface RoutineDocumentStatus {
  path: string;
  valid: boolean;
  timezone: string;
  updatedAt?: string;
  error?: string;
}

export interface DailyPlanSegment {
  period: DayPeriod;
  start: string;
  end: string;
  /** Estimated playback duration of the selected items, using the planner fallback for unknown lengths. */
  targetDurationMs: number;
  weather: WeatherKind;
  temperature?: number;
  routine: RoutineBlock[];
  items: RadioPlanItem[];
}

export interface DailyPlan {
  date: string;
  timezone: string;
  revision: number;
  generatedAt: string;
  contextHash: string;
  consumedTrackKeys: TrackKey[];
  segments: DailyPlanSegment[];
}

export interface PlayDailyPlanResponse {
  period: DayPeriod;
  now: NowPlayingState;
}

export interface FavoriteRequest {
  favorite: boolean;
}

export interface FavoriteResponse {
  favorite: boolean;
  taste: TasteProfile;
  learningReceipt?: LearningReceipt;
}

export interface PlayTrackRequest {
  track: Track;
  reason?: string;
}

export interface NextRequest {
  forceReplan?: boolean;
}

export interface NextResponse {
  now: NowPlayingState;
}

export interface PlayTrackResponse {
  now: NowPlayingState;
}

export type NcmImportErrorCode =
  | "ncm_unreachable"
  | "ncm_cookie_missing"
  | "ncm_not_logged_in"
  | "ncm_likes_empty"
  | "ncm_track_details_empty"
  | "ncm_request_failed"
  | "ncm_import_in_progress";

export interface SystemStatus {
  runningRoot: string;
  ncmReachable: boolean;
  aiDjConfigured: boolean;
  aiDjProvider: string;
  aiDjModel?: string;
  aiDjBaseUrlConfigured?: boolean;
  aiDjLastError?: string;
  trackStatsCount: number;
  queueLength: number;
  lastImportAt?: string;
  lastImportError?: string;
  lastImportErrorCode?: NcmImportErrorCode;
  environment?: EnvironmentContext;
  djSettings?: DjSettings;
  realtimeConversationMode?: "unified" | "legacy";
  inputTranscriptionEnabled?: boolean;
  realtimeLastError?: string;
  musicSources?: MusicSourceStatus[];
  tasteDocument?: TasteDocumentStatus;
  routineDocument?: RoutineDocumentStatus;
  dailyPlanRevision?: number;
  intelligencePolicy?: IntelligencePolicyStatus;
}

export interface IntelligencePolicyStatus {
  mode: IntelligencePolicyMode;
  version: string;
  shadowSampleCount: number;
  shadowStartedAt?: string;
  adaptiveProtectionRemaining?: number;
  fallbackReason?: string;
  environmentOverride: boolean;
}

export interface ImportNcmResponse {
  ok: boolean;
  importedCount: number;
  systemStatus: SystemStatus;
  error?: string;
  errorCode?: NcmImportErrorCode;
}

export interface WsPayload {
  event:
    | "now_playing_updated"
    | "queue_updated"
    | "dj_script_ready"
    | "system_status"
    | "chat_memory_updated"
    | "conversation_updated"
    | "music_sources_updated"
    | "taste_updated"
    | "daily_plan_updated"
    | "learning_receipt"
    | "session_intent_updated"
    | "policy_status";
  data: unknown;
}
