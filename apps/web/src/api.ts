import type {
  ChatMemory,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  DjSettings,
  EnvironmentContext,
  EnvironmentLocationRequest,
  FavoriteResponse,
  FeedbackRequest,
  ImportNcmResponse,
  NextResponse,
  NowPlayingState,
  MusicCommandRequest,
  MusicCommandResult,
  PlayTrackResponse,
  RealtimeContextResponse,
  RecommendationImportResponse,
  SystemStatus,
  TasteProfile,
  Track,
  VoiceTurnCompleteRequest,
  VoiceTurnStartRequest,
  VoiceTurnStartResponse
} from "@musicgpt/shared";
import { API_ROUTES } from "@musicgpt/shared";

export class ChatStreamInterruptedError extends Error {
  constructor() {
    super("Chat stream was interrupted");
    this.name = "ChatStreamInterruptedError";
  }
}

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

export async function sendChat(message: string, turnId?: string): Promise<ChatResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, ...(turnId ? { turnId } : {}) })
  });
  if (!response.ok) {
    throw new Error("Chat failed");
  }
  return (await response.json()) as ChatResponse;
}

export async function sendChatStream(
  message: string,
  options: {
    signal?: AbortSignal;
    turnId?: string;
    onEvent: (event: ChatStreamEvent) => void;
  }
): Promise<ChatResponse> {
  const response = await fetch(API_ROUTES.chatStream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, ...(options.turnId ? { turnId: options.turnId } : {}) }),
    ...(options.signal ? { signal: options.signal } : {})
  });
  return readChatEventStream(response, options.onEvent);
}

export async function readChatEventStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void
): Promise<ChatResponse> {
  if (!response.ok || !response.body) {
    throw new Error("Chat stream failed");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ChatResponse | undefined;

  const consumeLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(line) as ChatStreamEvent;
    } catch {
      throw new ChatStreamInterruptedError();
    }
    onEvent(event);
    if (event.type === "error") {
      throw new Error(event.message);
    }
    if (event.type === "result") {
      result = event.response;
    }
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new ChatStreamInterruptedError();
    }
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (chunk.done) {
      break;
    }
  }
  consumeLine(buffer);

  if (!result) {
    throw new ChatStreamInterruptedError();
  }
  return result;
}

export async function fetchChatHistory(): Promise<ChatMessage[]> {
  const response = await fetch("/api/chat/history");
  if (!response.ok) {
    throw new Error("Failed to load chat history");
  }
  const payload = (await response.json()) as { messages: ChatMessage[] };
  return payload.messages;
}

export async function fetchChatMemories(): Promise<ChatMemory[]> {
  const response = await fetch(API_ROUTES.chatMemories);
  if (!response.ok) {
    throw new Error("Failed to load chat memories");
  }
  const payload = (await response.json()) as { memories: ChatMemory[] };
  return payload.memories;
}

export async function deleteChatMemory(memoryId: number): Promise<void> {
  const response = await fetch(API_ROUTES.chatMemory(memoryId), {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("Failed to delete chat memory");
  }
}

export async function clearChatMemories(): Promise<void> {
  const response = await fetch(API_ROUTES.chatMemories, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error("Failed to clear chat memories");
  }
}

export async function startVoiceTurn(input: VoiceTurnStartRequest): Promise<VoiceTurnStartResponse> {
  const response = await fetchWithMemoryRetry(API_ROUTES.voiceTurns, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error("Voice turn could not be saved");
  return response.json() as Promise<VoiceTurnStartResponse>;
}

export async function completeVoiceTurn(
  turnId: string,
  input: VoiceTurnCompleteRequest
): Promise<ChatMessage[]> {
  const response = await fetchWithMemoryRetry(API_ROUTES.voiceTurnComplete(turnId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error("Voice turn could not be completed");
  const payload = await response.json() as { messages: ChatMessage[] };
  return payload.messages;
}

export async function runMusicCommand(input: MusicCommandRequest): Promise<MusicCommandResult> {
  const response = await fetchWithMemoryRetry(API_ROUTES.musicCommands, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error("Music command failed");
  return response.json() as Promise<MusicCommandResult>;
}

async function fetchWithMemoryRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  attempts = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.status < 500 || attempt === attempts - 1) return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

export async function fetchRealtimeContext(
  sessionId: string,
  baselineRevision: number
): Promise<RealtimeContextResponse> {
  const query = new URLSearchParams({ sessionId, baselineRevision: String(baselineRevision) });
  const response = await fetch(`${API_ROUTES.realtimeContext}?${query}`);
  if (!response.ok) throw new Error("Realtime context refresh failed");
  return response.json() as Promise<RealtimeContextResponse>;
}

export async function reportRealtimeError(code: string): Promise<void> {
  await fetch(API_ROUTES.realtimeErrors, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.slice(0, 200) })
  });
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

export async function playQueuedTrack(trackId: number): Promise<PlayTrackResponse> {
  const response = await fetch(`/api/queue/${trackId}/play`, {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Failed to play queued track");
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

export async function setFavorite(trackId: number, favorite: boolean): Promise<FavoriteResponse> {
  const response = await fetch(API_ROUTES.favorite(trackId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ favorite })
  });
  if (!response.ok) {
    throw new Error("Favorite update failed");
  }
  return (await response.json()) as FavoriteResponse;
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
