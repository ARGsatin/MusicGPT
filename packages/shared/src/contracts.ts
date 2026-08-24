import type {
  ChatRequest,
  DjSettings,
  EnvironmentLocationRequest,
  FavoriteRequest,
  FeedbackRequest,
  NextRequest,
  PlayTrackRequest,
  TrackReference,
  WsPayload
} from "./types.js";

export const API_ROUTES = {
  chat: "/api/chat",
  chatStream: "/api/chat/stream",
  chatHistory: "/api/chat/history",
  chatMemories: "/api/chat/memories",
  chatMemory: (memoryId: number) => `/api/chat/memories/${memoryId}`,
  realtimeSession: "/api/realtime/session",
  realtimeContext: "/api/realtime/context",
  realtimeErrors: "/api/realtime/errors",
  voiceTurns: "/api/conversation/voice/turns",
  voiceTurnComplete: (turnId: string) => `/api/conversation/voice/turns/${encodeURIComponent(turnId)}/complete`,
  musicCommands: "/api/music/commands",
  now: "/api/now",
  next: "/api/next",
  playTrack: "/api/play-track",
  taste: "/api/taste",
  feedback: "/api/feedback",
  favorite: (trackId: TrackReference) => `/api/favorites/${encodeURIComponent(String(trackId))}`,
  systemStatus: "/api/system/status",
  importNcm: "/api/import/ncm",
  environment: "/api/environment",
  environmentLocation: "/api/environment/location",
  importRecommendations: "/api/recommendations/import",
  musicSources: "/api/music-sources",
  qqAuthQr: "/api/music-sources/qq/auth/qr",
  qqAuthQrStatus: (sessionId: string) => `/api/music-sources/qq/auth/qr/${encodeURIComponent(sessionId)}`,
  qqDisconnect: "/api/music-sources/qq/auth",
  musicSourceSync: (source: "ncm" | "qq") => `/api/music-sources/${source}/sync`,
  libraryExport: "/api/library/export",
  dailyPlan: "/api/daily-plan",
  regenerateDailyPlan: "/api/daily-plan/regenerate",
  playDailyPlan: "/api/daily-plan/play",
  djSettings: "/api/dj/settings",
  ws: "/ws/stream"
} as const;

export function isChatRequest(value: unknown): value is ChatRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as ChatRequest;
  return typeof maybe.message === "string" && maybe.message.trim().length > 0;
}

export function isNextRequest(value: unknown): value is NextRequest {
  if (!value || typeof value !== "object") {
    return true;
  }
  const maybe = value as NextRequest;
  return maybe.forceReplan === undefined || typeof maybe.forceReplan === "boolean";
}

export function isFeedbackRequest(value: unknown): value is FeedbackRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as FeedbackRequest;
  return (
    (typeof maybe.trackId === "number" || typeof maybe.trackId === "string") &&
    ["skip", "like", "unlike", "replay", "complete"].includes(maybe.type)
  );
}

export function isFavoriteRequest(value: unknown): value is FavoriteRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof (value as FavoriteRequest).favorite === "boolean";
}

export function isPlayTrackRequest(value: unknown): value is PlayTrackRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as PlayTrackRequest;
  return (
    Boolean(maybe.track) &&
    typeof maybe.track === "object" &&
    (typeof maybe.track.id === "number" || typeof maybe.track.id === "string") &&
    typeof maybe.track.title === "string" &&
    Array.isArray(maybe.track.artists) &&
    maybe.track.artists.every((artist) => typeof artist === "string") &&
    (maybe.reason === undefined || typeof maybe.reason === "string")
  );
}

export function isEnvironmentLocationRequest(value: unknown): value is EnvironmentLocationRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as EnvironmentLocationRequest;
  return (
    typeof maybe.latitude === "number" &&
    Number.isFinite(maybe.latitude) &&
    maybe.latitude >= -90 &&
    maybe.latitude <= 90 &&
    typeof maybe.longitude === "number" &&
    Number.isFinite(maybe.longitude) &&
    maybe.longitude >= -180 &&
    maybe.longitude <= 180 &&
    (maybe.label === undefined || typeof maybe.label === "string")
  );
}

export function isDjSettingsRequest(value: unknown): value is DjSettings {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as DjSettings;
  return (
    ["lively", "calm", "professional"].includes(maybe.tone) &&
    ["female", "male"].includes(maybe.voiceGender) &&
    typeof maybe.voice === "string" &&
    maybe.voice.trim().length > 0
  );
}

export function encodeWsPayload(payload: WsPayload): string {
  return JSON.stringify(payload);
}
