export const VOLUME_STORAGE_KEY = "musicgpt.player-volume";

export interface PlayerVolume {
  level: number;
  muted: boolean;
}

export const DEFAULT_PLAYER_VOLUME: PlayerVolume = {
  level: 1,
  muted: false
};

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;
type VolumeOutput = Pick<HTMLMediaElement, "volume" | "muted">;

export interface VolumeFadeScheduler {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export function normalizeVolumeLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return DEFAULT_PLAYER_VOLUME.level;
  }
  return Math.min(1, Math.max(0, level));
}

export function loadPlayerVolume(storage: ReadableStorage | undefined): PlayerVolume {
  if (!storage) {
    return DEFAULT_PLAYER_VOLUME;
  }

  try {
    const saved = storage.getItem(VOLUME_STORAGE_KEY);
    if (!saved) {
      return DEFAULT_PLAYER_VOLUME;
    }

    const value = JSON.parse(saved) as Partial<PlayerVolume>;
    if (typeof value.level !== "number" || typeof value.muted !== "boolean") {
      return DEFAULT_PLAYER_VOLUME;
    }

    return { level: normalizeVolumeLevel(value.level), muted: value.muted };
  } catch {
    return DEFAULT_PLAYER_VOLUME;
  }
}

export function applyPlayerVolume(output: VolumeOutput, preference: PlayerVolume): void {
  output.volume = normalizeVolumeLevel(preference.level);
  output.muted = preference.muted;
}

export function fadePlayerVolume(
  output: VolumeOutput,
  preference: PlayerVolume,
  durationMs: number,
  scheduler: VolumeFadeScheduler = browserVolumeFadeScheduler
): () => void {
  const targetLevel = normalizeVolumeLevel(preference.level);
  const startLevel = normalizeVolumeLevel(output.volume);
  output.muted = preference.muted;

  if (preference.muted || durationMs <= 0 || startLevel === targetLevel) {
    output.volume = targetLevel;
    return () => undefined;
  }

  const startedAt = scheduler.now();
  let frameHandle = 0;
  let cancelled = false;

  const update = (timestamp: number) => {
    if (cancelled) {
      return;
    }
    const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / durationMs));
    const easedProgress = progress * progress * (3 - 2 * progress);
    output.volume = startLevel + (targetLevel - startLevel) * easedProgress;
    if (progress < 1) {
      frameHandle = scheduler.requestFrame(update);
    } else {
      output.volume = targetLevel;
    }
  };

  frameHandle = scheduler.requestFrame(update);
  return () => {
    cancelled = true;
    scheduler.cancelFrame(frameHandle);
  };
}

export function savePlayerVolume(storage: WritableStorage | undefined, preference: PlayerVolume): void {
  try {
    storage?.setItem(VOLUME_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Playback must continue even when private browsing blocks local storage.
  }
}

const browserVolumeFadeScheduler: VolumeFadeScheduler = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle)
};
