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
  queue: RadioPlanItem[];
  startedAt?: string;
  paused: boolean;
  djScript?: DjScript;
}

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  action: "skip" | "pause" | "resume" | "replan" | "play_specific" | "noop";
  reply: string;
  now: NowPlayingState;
}

export interface FeedbackRequest {
  type: FeedbackType;
  trackId: number;
}

export interface NextRequest {
  forceReplan?: boolean;
}

export interface NextResponse {
  now: NowPlayingState;
}

export interface WsPayload {
  event: "now_playing_updated" | "queue_updated" | "dj_tts_ready";
  data: unknown;
}
