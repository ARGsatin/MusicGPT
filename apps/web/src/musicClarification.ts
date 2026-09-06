import type { MusicCommandRequest, MusicCommandResult, Track } from "@musicgpt/shared";

export interface PendingMusicClarification {
  question: string;
  candidates: Track[];
  confirmationToken: string;
  turnId: string;
  request: string;
}

export function pendingClarificationFromResult(
  result: MusicCommandResult,
  context: Pick<PendingMusicClarification, "turnId" | "request">
): PendingMusicClarification | null {
  if (result.outcome !== "needs_confirmation" || !result.confirmationToken) return null;
  const candidates = result.clarification?.candidates?.length
    ? result.clarification.candidates
    : result.candidates ?? [];
  if (!result.clarification?.question || candidates.length === 0) return null;
  return {
    question: result.clarification.question,
    candidates,
    confirmationToken: result.confirmationToken,
    turnId: context.turnId,
    request: context.request
  };
}

export function buildConfirmationRequest(
  clarification: PendingMusicClarification,
  candidate: Track
): MusicCommandRequest {
  return {
    turnId: clarification.turnId,
    commandId: createCommandId(),
    request: clarification.request,
    mode: "text_suggest",
    confirmationToken: clarification.confirmationToken,
    selectedTrackId: candidate.trackKey ?? candidate.id
  };
}

function createCommandId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
