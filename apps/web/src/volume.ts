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

export function savePlayerVolume(storage: WritableStorage | undefined, preference: PlayerVolume): void {
  try {
    storage?.setItem(VOLUME_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Playback must continue even when private browsing blocks local storage.
  }
}
