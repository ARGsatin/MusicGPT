import type {
  NowPlayingState,
  PlaybackOutcome,
  PlaybackOutcomeRequest,
  TrackReference
} from "@musicgpt/shared";

export interface ActivePlaybackSnapshot {
  playbackId: string;
  trackId: TrackReference;
  decisionId?: string;
  listenedMs: number;
  durationMs?: number;
}

export function playbackSnapshotFromNow(
  now: NowPlayingState,
  listenedMs = 0,
  durationMs?: number
): ActivePlaybackSnapshot | undefined {
  if (!now.track || !now.playbackId) return undefined;
  return {
    playbackId: now.playbackId,
    trackId: now.track.trackKey ?? now.track.id,
    ...(now.decision?.decisionId ? { decisionId: now.decision.decisionId } : {}),
    listenedMs: Math.max(0, Math.round(listenedMs)),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs: Math.round(durationMs) } : {})
  };
}

export function outcomeFromSnapshot(
  snapshot: ActivePlaybackSnapshot,
  outcome: PlaybackOutcome
): PlaybackOutcomeRequest {
  return { ...snapshot, outcome };
}

export function snapshotForNowTransition(
  current: ActivePlaybackSnapshot | undefined,
  next: NowPlayingState
): ActivePlaybackSnapshot | undefined {
  if (current && next.playbackId === current.playbackId) {
    return playbackSnapshotFromNow(
      next,
      current.listenedMs,
      current.durationMs ?? next.track?.durationMs
    );
  }
  return playbackSnapshotFromNow(
    next,
    0,
    next.track?.durationMs
  );
}

export async function runAfterPlaybackFinalized<T>(
  finalize: () => Promise<void>,
  startTransition: () => Promise<T>
): Promise<T> {
  await finalize();
  return startTransition();
}
