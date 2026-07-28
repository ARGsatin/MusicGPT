import type {
  ChatMessage,
  ChatResponse,
  ChatSpeechResponse,
  DjSettings,
  EnvironmentContext,
  EnvironmentLocationRequest,
  FeedbackRequest,
  ImportNcmResponse,
  NextResponse,
  NowPlayingState,
  PlayTrackResponse,
  RecommendationImportResponse,
  SystemStatus,
  TasteProfile,
  Track
} from "@musicgpt/shared";
import { API_ROUTES } from "@musicgpt/shared";

export async function fetchNowPlaying(): Promise<NowPlayingState> {
  const response = await fetch("/api/now");
  if (!response.ok) {
    throw new Error("Failed to load now playing");
  }
  return (await response.json()) as NowPlayingState;
}

export async function fetchTaste(): Promise<TasteProfile | null> {
  const response = await fetch("/api/taste");
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Failed to load taste profile");
  }
  return (await response.json()) as TasteProfile;
}

export async function sendChat(message: string): Promise<ChatResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) {
    throw new Error("Chat failed");
  }
  return (await response.json()) as ChatResponse;
}

export async function fetchChatHistory(): Promise<ChatMessage[]> {
  const response = await fetch("/api/chat/history");
  if (!response.ok) {
    throw new Error("Failed to load chat history");
  }
  const payload = (await response.json()) as { messages: ChatMessage[] };
  return payload.messages;
}

export async function generateChatSpeech(messageId: number): Promise<ChatSpeechResponse> {
  const response = await fetch(API_ROUTES.chatSpeech(messageId), {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Speech synthesis failed");
  }
  return (await response.json()) as ChatSpeechResponse;
}

export async function clearChatHistory(): Promise<void> {
  const response = await fetch("/api/chat/history", {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("Failed to clear chat history");
  }
}

export async function requestNext(forceReplan = false): Promise<NextResponse> {
  const response = await fetch("/api/next", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ forceReplan })
  });
  if (!response.ok) {
    throw new Error("Failed to fetch next track");
  }
  return (await response.json()) as NextResponse;
}

export async function playSuggestedTrack(track: Track, reason?: string): Promise<PlayTrackResponse> {
  const response = await fetch("/api/play-track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, reason })
  });
  if (!response.ok) {
    throw new Error("Failed to play suggested track");
  }
  return (await response.json()) as PlayTrackResponse;
}

export async function sendFeedback(payload: FeedbackRequest): Promise<void> {
  const response = await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Feedback failed");
  }
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const response = await fetch("/api/system/status");
  if (!response.ok) {
    throw new Error("Failed to load system status");
  }
  return (await response.json()) as SystemStatus;
}

export async function fetchEnvironment(): Promise<EnvironmentContext> {
  const response = await fetch("/api/environment");
  if (!response.ok) {
    throw new Error("Failed to load environment");
  }
  return (await response.json()) as EnvironmentContext;
}

export async function updateEnvironmentLocation(
  payload: EnvironmentLocationRequest
): Promise<EnvironmentContext> {
  const response = await fetch("/api/environment/location", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Weather location update failed");
  }
  return (await response.json()) as EnvironmentContext;
}

export async function importRecommendations(): Promise<RecommendationImportResponse> {
  const response = await fetch("/api/recommendations/import", {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Recommendation import failed");
  }
  return (await response.json()) as RecommendationImportResponse;
}

export async function fetchDjSettings(): Promise<DjSettings> {
  const response = await fetch("/api/dj/settings");
  if (!response.ok) {
    throw new Error("Failed to load DJ settings");
  }
  return (await response.json()) as DjSettings;
}

export async function updateDjSettings(payload: DjSettings): Promise<DjSettings> {
  const response = await fetch("/api/dj/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Failed to update DJ settings");
  }
  return (await response.json()) as DjSettings;
}

export async function importFromNcm(): Promise<ImportNcmResponse> {
  const response = await fetch("/api/import/ncm", {
    method: "POST"
  });
  const payload = (await response.json()) as ImportNcmResponse;
  if (!response.ok) {
    throw new Error(payload.error ?? "NCM import failed");
  }
  return payload;
}
