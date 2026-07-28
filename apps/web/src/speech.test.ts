import { describe, expect, it } from "vitest";

import {
  AUTO_SPEAK_STORAGE_KEY,
  getDuckedPlayerVolume,
  loadAutoSpeak,
  saveAutoSpeak,
  SpeechPlaybackController
} from "./speech";

describe("chat speech preferences", () => {
  it("defaults auto speech on, persists the toggle, and ducks without changing mute intent", () => {
    expect(loadAutoSpeak(undefined)).toBe(true);

    let savedKey = "";
    let savedValue = "";
    saveAutoSpeak(
      {
        setItem(key, value) {
          savedKey = key;
          savedValue = value;
        }
      },
      false
    );

    expect(savedKey).toBe(AUTO_SPEAK_STORAGE_KEY);
    expect(savedValue).toBe("false");
    expect(loadAutoSpeak({ getItem: () => "false" })).toBe(false);
    expect(getDuckedPlayerVolume({ level: 0.8, muted: false }, true)).toEqual({
      level: 0.2,
      muted: false
    });
    expect(getDuckedPlayerVolume({ level: 0.8, muted: true }, true)).toEqual({
      level: 0.8,
      muted: true
    });
  });
});

describe("speech playback queue", () => {
  it("queues a DJ broadcast behind chat speech without overlapping audio", async () => {
    const audio = new FakeSpeechAudio();
    const activeStates: boolean[] = [];
    const controller = new SpeechPlaybackController(audio, {
      onActiveChange: (active) => activeStates.push(active)
    });

    await controller.playNow({ key: "chat:2", audioUrl: "/chat.mp3", kind: "chat" });
    controller.enqueueDj({ key: "dj:7", audioUrl: "/dj.mp3", kind: "dj" });

    expect(audio.playedSources).toEqual(["/chat.mp3"]);
    audio.emit("ended");
    await Promise.resolve();
    expect(audio.playedSources).toEqual(["/chat.mp3", "/dj.mp3"]);
    audio.emit("ended");
    controller.enqueueDj({ key: "dj:7", audioUrl: "/dj.mp3", kind: "dj" });
    await Promise.resolve();

    expect(audio.playedSources).toEqual(["/chat.mp3", "/dj.mp3"]);
    expect(activeStates).toEqual([true, false]);
    controller.dispose();
  });

  it("interrupts current speech for a manual replay and recovers from blocked playback", async () => {
    const audio = new FakeSpeechAudio();
    const activeStates: boolean[] = [];
    const failedKeys: string[] = [];
    const controller = new SpeechPlaybackController(audio, {
      onActiveChange: (active) => activeStates.push(active),
      onPlaybackError: (job) => failedKeys.push(job.key)
    });

    await controller.playNow({ key: "dj:1", audioUrl: "/first.mp3", kind: "dj" });
    await controller.playNow({ key: "chat:3", audioUrl: "/second.mp3", kind: "chat" });
    expect(audio.pauseCount).toBe(1);
    expect(audio.playedSources).toEqual(["/first.mp3", "/second.mp3"]);

    audio.rejectNextPlay = true;
    const played = await controller.playNow({
      key: "chat:4",
      audioUrl: "/blocked.mp3",
      kind: "chat"
    });

    expect(played).toBe(false);
    expect(failedKeys).toEqual(["chat:4"]);
    expect(activeStates.at(-1)).toBe(false);
    controller.dispose();
  });
});

class FakeSpeechAudio {
  src = "";
  currentTime = 0;
  readonly playedSources: string[] = [];
  pauseCount = 0;
  rejectNextPlay = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  async play(): Promise<void> {
    this.playedSources.push(this.src);
    if (this.rejectNextPlay) {
      this.rejectNextPlay = false;
      throw new Error("NotAllowedError");
    }
  }

  pause(): void {
    this.pauseCount += 1;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}
