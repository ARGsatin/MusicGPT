import { describe, expect, it } from "vitest";

import {
  applyPlayerVolume,
  fadePlayerVolume,
  loadPlayerVolume,
  savePlayerVolume,
  type VolumeFadeScheduler,
  VOLUME_STORAGE_KEY
} from "./volume";

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

  it("fades music to the speech ducking level and can cancel an in-progress fade", () => {
    const scheduler = new FakeVolumeFadeScheduler();
    const audio = { volume: 0.8, muted: false };

    const cancel = fadePlayerVolume(
      audio,
      { level: 0.2, muted: false },
      500,
      scheduler
    );
    scheduler.advanceTo(250);
    expect(audio.volume).toBeCloseTo(0.5);
    scheduler.advanceTo(500);
    expect(audio.volume).toBeCloseTo(0.2);

    audio.volume = 0.2;
    const cancelRestore = fadePlayerVolume(
      audio,
      { level: 0.8, muted: false },
      500,
      scheduler
    );
    scheduler.advanceTo(750);
    expect(audio.volume).toBeCloseTo(0.5);
    cancelRestore();
    scheduler.advanceTo(1_000);
    expect(audio.volume).toBeCloseTo(0.5);
    cancel();
  });
});

class FakeVolumeFadeScheduler implements VolumeFadeScheduler {
  private timestamp = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  now(): number {
    return this.timestamp;
  }

  requestFrame(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle);
  }

  advanceTo(timestamp: number): void {
    this.timestamp = timestamp;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback(timestamp);
    }
  }
}
