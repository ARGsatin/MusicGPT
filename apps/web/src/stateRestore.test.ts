import { describe, expect, it } from "vitest";

import { selectFulfilledRestoreState } from "./stateRestore";

describe("full state restoration", () => {
  it("keeps every successful slice when another restore request fails", () => {
    const result = selectFulfilledRestoreState({
      now: { status: "fulfilled", value: { queue: [], paused: false, playbackId: "play-1" } },
      taste: { status: "rejected", reason: new Error("taste offline") },
      systemStatus: {
        status: "fulfilled",
        value: {
          runningRoot: "D:/MusicGPT",
          ncmReachable: true,
          aiDjConfigured: true,
          aiDjProvider: "deepseek",
          trackStatsCount: 4,
          queueLength: 2
        }
      },
      musicSources: { status: "rejected", reason: new Error("sources offline") },
      dailyPlan: { status: "fulfilled", value: null }
    });

    expect(result.now?.playbackId).toBe("play-1");
    expect("taste" in result).toBe(false);
    expect(result.detail.dailyPlan).toBeNull();
    expect("musicSources" in result.detail).toBe(false);
    expect(result.detail.systemStatus?.ncmReachable).toBe(true);
  });
});
