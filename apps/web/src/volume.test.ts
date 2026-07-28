import { describe, expect, it } from "vitest";

import { applyPlayerVolume, loadPlayerVolume, savePlayerVolume, VOLUME_STORAGE_KEY } from "./volume";

describe("player volume preferences", () => {
  it("restores the saved volume and mute state", () => {
    const storage = {
      getItem: (key: string) =>
        key === VOLUME_STORAGE_KEY ? JSON.stringify({ level: 0.35, muted: true }) : null
    };

    expect(loadPlayerVolume(storage)).toEqual({ level: 0.35, muted: true });
  });

  it("applies the selected level and mute state to the audio output", () => {
    const audio = { volume: 1, muted: false };

    applyPlayerVolume(audio, { level: 0.42, muted: true });

    expect(audio).toEqual({ volume: 0.42, muted: true });
  });

  it("saves volume changes for the next visit", () => {
    let savedKey = "";
    let savedValue = "";
    const storage = {
      setItem: (key: string, value: string) => {
        savedKey = key;
        savedValue = value;
      }
    };

    savePlayerVolume(storage, { level: 0.73, muted: false });

    expect(savedKey).toBe(VOLUME_STORAGE_KEY);
    expect(JSON.parse(savedValue)).toEqual({ level: 0.73, muted: false });
  });

  it("clamps an out-of-range saved level to a valid media volume", () => {
    const storage = {
      getItem: () => JSON.stringify({ level: 4, muted: false })
    };

    expect(loadPlayerVolume(storage)).toEqual({ level: 1, muted: false });
  });
});
