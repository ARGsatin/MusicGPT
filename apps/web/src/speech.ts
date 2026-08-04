import type { PlayerVolume } from "./volume";

export const AUTO_SPEAK_STORAGE_KEY = "musicgpt.realtime.auto-speak";
export const SPEECH_DUCKING_RATIO = 0.25;
export const SPEECH_DUCKING_FADE_MS = 500;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function loadAutoSpeak(storage: ReadableStorage | undefined): boolean {
  if (!storage) {
    return true;
  }
  try {
    const saved = storage.getItem(AUTO_SPEAK_STORAGE_KEY);
    return saved === null ? true : saved !== "false";
  } catch {
    return true;
  }
}

export function saveAutoSpeak(storage: WritableStorage | undefined, enabled: boolean): void {
  try {
    storage?.setItem(AUTO_SPEAK_STORAGE_KEY, String(enabled));
  } catch {
    // Realtime voice still works if private browsing blocks local storage.
  }
}

export function getDuckedPlayerVolume(
  preference: PlayerVolume,
  speechActive: boolean
): PlayerVolume {
  if (!speechActive || preference.muted) {
    return preference;
  }
  return {
    ...preference,
    level: preference.level * SPEECH_DUCKING_RATIO
  };
}
