import type { FeedbackReason, FeedbackRequest, TrackReference } from "@musicgpt/shared";

export function buildTeachingFeedback(input: {
  reason: FeedbackReason;
  trackId: TrackReference;
  listenedMs: number;
  durationMs?: number;
  playbackId?: string;
  decisionId?: string;
}): FeedbackRequest {
  return {
    type: "teach",
    trackId: input.trackId,
    reason: input.reason,
    scope: input.reason === "wrong_for_now" || input.reason === "bad_version" ? "session" : "long_term",
    listenedMs: input.listenedMs,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.playbackId ? { playbackId: input.playbackId } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {})
  };
}
