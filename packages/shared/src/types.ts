export type MoodTag =
  | "calm"
  | "focus"
  | "warm"
  | "night"
  | "energy"
  | "nostalgia"
  | "unknown";

export type DayPeriod = "morning" | "afternoon" | "evening" | "late_night";

export type FeedbackType = "skip" | "like" | "replay" | "complete";

export type WeatherKind = "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm" | "unknown";

export type DjTone = "lively" | "calm" | "professional";

export type VoiceGender = "female" | "male";

export interface Track {
  id: number;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  songUrl?: string;
  moodTag?: MoodTag;
}

export interface TrackStat {
  track: Track;
  likedAt?: string;
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
  trackId: number;
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
    id: number;
    title: string;
    playCount: number;
  }>;
  favoritePeriods: Array<{
    period: DayPeriod;
    weight: number;
  }>;
  moodWeights: Record<MoodTag, number>;
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
}

export interface PlayEvent {
  type: FeedbackType;
  trackId: number;
  at: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface DjScript {
  id: string;
  text: string;
  reason: string;
  trackIds: number[];
  createdAt: string;
  audioUrl?: string;
}

export interface NowPlayingState {
  track?: Track;
  lyrics?: TrackLyrics;
  queue: RadioPlanItem[];
  startedAt?: string;
  paused: boolean;
  djScript?: DjScript;
}

export interface ChatRequest {
  message: string;
}

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  trackSuggestion?: TrackSuggestion;
  speech?: ChatSpeech;
}

export interface ChatSpeech {
  audioUrl: string;
  profileKey: string;
}

export interface ChatSpeechResponse {
  messageId: number;
  audioUrl: string;
}

export type ChatStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "speech"; sequence: number; text: string; audioUrl: string }
  | { type: "result"; response: ChatResponse }
  | { type: "error"; message: string };

export interface TrackSuggestion {
  id: string;
  track: Track;
  reason: string;
  createdAt: string;
}

export interface ChatResponse {
  action:
    | "skip"
    | "pause"
    | "resume"
    | "replan"
    | "play_specific"
    | "play_by_description"
    | "comment_current"
    | "noop";
  reply: string;
  now: NowPlayingState;
  messages: ChatMessage[];
}

export interface FeedbackRequest {
  type: FeedbackType;
  trackId: number;
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
}

export interface ImportNcmResponse {
  ok: boolean;
  importedCount: number;
  systemStatus: SystemStatus;
  error?: string;
  errorCode?: NcmImportErrorCode;
}

export interface WsPayload {
  event: "now_playing_updated" | "queue_updated" | "dj_tts_ready" | "system_status";
  data: unknown;
}
