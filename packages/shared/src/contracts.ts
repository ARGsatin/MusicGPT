import type {
  ChatRequest,
  DjSettings,
  EnvironmentLocationRequest,
  FavoriteRequest,
  FeedbackRequest,
  LearningUndoRequest,
  NextRequest,
  PlaybackOutcomeRequest,
  PlayTrackRequest,
  TasteSignalMutationRequest,
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
  tasteSignals: "/api/taste/signals",
  feedback: "/api/feedback",
  listeningOutcomes: "/api/listening/outcomes",
  learningUndo: "/api/learning/undo",
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
  const validReason =
    maybe.reason === undefined ||
    [
      "dislike_track",
      "less_this_artist",
      "wrong_for_now",
      "overplayed",
      "bad_version",
      "playback_problem"
    ].includes(maybe.reason);
  const validScope = maybe.scope === undefined || ["session", "day", "long_term"].includes(maybe.scope);
  const validOptionalId = (id: string | undefined) => id === undefined || (typeof id === "string" && id.length > 0);
  const validDuration = (duration: number | undefined) =>
    duration === undefined || (typeof duration === "number" && Number.isFinite(duration) && duration >= 0);
  return (
    (typeof maybe.trackId === "number" || typeof maybe.trackId === "string") &&
    ["skip", "like", "unlike", "replay", "complete", "teach"].includes(maybe.type) &&
    validReason &&
    validScope &&
    validOptionalId(maybe.playbackId) &&
    validOptionalId(maybe.decisionId) &&
    validDuration(maybe.listenedMs) &&
    validDuration(maybe.durationMs)
  );
}

export function isPlaybackOutcomeRequest(value: unknown): value is PlaybackOutcomeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as PlaybackOutcomeRequest;
  return (
    typeof maybe.playbackId === "string" &&
    maybe.playbackId.length > 0 &&
    (typeof maybe.trackId === "number" || typeof maybe.trackId === "string") &&
    ["completed", "skipped", "abandoned", "playback_error"].includes(maybe.outcome) &&
    typeof maybe.listenedMs === "number" &&
    Number.isFinite(maybe.listenedMs) &&
    maybe.listenedMs >= 0 &&
    (maybe.durationMs === undefined ||
      (typeof maybe.durationMs === "number" && Number.isFinite(maybe.durationMs) && maybe.durationMs >= 0)) &&
    (maybe.decisionId === undefined || (typeof maybe.decisionId === "string" && maybe.decisionId.length > 0)) &&
    (maybe.at === undefined || (typeof maybe.at === "string" && !Number.isNaN(Date.parse(maybe.at))))
  );
}

export function isLearningUndoRequest(value: unknown): value is LearningUndoRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as LearningUndoRequest).undoToken === "string" &&
      (value as LearningUndoRequest).undoToken.length > 0
  );
}

export function isTasteSignalMutationRequest(value: unknown): value is TasteSignalMutationRequest {
  if (!value || typeof value !== "object") return false;
  const maybe = value as TasteSignalMutationRequest;
  if (!["confirm", "decrease", "block", "delete", "reset_automatic"].includes(maybe.action)) {
    return false;
  }
  if (maybe.action === "reset_automatic") {
    return maybe.signalId === undefined;
  }
  return typeof maybe.signalId === "string" && maybe.signalId.length > 0;
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
