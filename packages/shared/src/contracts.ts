import type {
  ChatRequest,
  FeedbackRequest,
  NextRequest,
  WsPayload
} from "./types.js";

export const API_ROUTES = {
  chat: "/api/chat",
  now: "/api/now",
  next: "/api/next",
  taste: "/api/taste",
  feedback: "/api/feedback",
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
    typeof maybe.trackId === "number" &&
    ["skip", "like", "replay", "complete"].includes(maybe.type)
  );
}

export function encodeWsPayload(payload: WsPayload): string {
  return JSON.stringify(payload);
}
