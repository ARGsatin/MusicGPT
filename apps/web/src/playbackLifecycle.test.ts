import { describe, expect, it } from "vitest";

import {
  outcomeFromSnapshot,
  runAfterPlaybackFinalized,
  snapshotForNowTransition
} from "./playbackLifecycle";

describe("playback lifecycle identity", () => {
  it("keeps the old playback identity when a new now state arrives", () => {
    const oldPlayback = {
      playbackId: "play-old",
      trackId: "qq:old",
      decisionId: "decision-old",
      listenedMs: 24_000,
      durationMs: 200_000
    };
    const newPlaybackId = "play-new";

    expect(outcomeFromSnapshot(oldPlayback, "abandoned")).toEqual({
      ...oldPlayback,
      outcome: "abandoned"
    });
    expect(outcomeFromSnapshot(oldPlayback, "abandoned").playbackId).not.toBe(newPlaybackId);
  });

  it("saves the active playback before an explicit UI switch starts", async () => {
    const events: string[] = [];

    await runAfterPlaybackFinalized(
      async () => { events.push("outcome accepted"); },
      async () => { events.push("switch requested"); }
    );

    expect(events).toEqual(["outcome accepted", "switch requested"]);
  });

  it("does not switch when the active playback cannot be finalized", async () => {
    let switched = false;

    await expect(runAfterPlaybackFinalized(
      async () => { throw new Error("offline"); },
      async () => { switched = true; }
    )).rejects.toThrow("offline");

    expect(switched).toBe(false);
  });

  it("preserves progress for the same playback and resets it for a new playback", () => {
    const active = {
      playbackId: "play-old",
      trackId: 1,
      listenedMs: 41_000,
      durationMs: 180_000
    };

    expect(snapshotForNowTransition(active, {
      playbackId: "play-old",
      track: { id: 1, title: "Old", artists: ["Artist"] },
      queue: [],
      paused: false
    })?.listenedMs).toBe(41_000);
    expect(snapshotForNowTransition(active, {
      playbackId: "play-new",
      track: { id: 2, title: "New", artists: ["Artist"] },
      queue: [],
      paused: false
    })).toMatchObject({ playbackId: "play-new", trackId: 2, listenedMs: 0 });
  });
});
