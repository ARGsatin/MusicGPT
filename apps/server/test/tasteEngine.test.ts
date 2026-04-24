import { describe, expect, it } from "vitest";

import type { PlayEvent, TrackStat } from "@musicgpt/shared";
import { TasteEngine } from "../src/tasteEngine.js";

const baseStats: TrackStat[] = [
  {
    track: { id: 1, title: "Morning Focus", artists: ["Artist A"], moodTag: "focus" },
    likedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    playCount: 60,
    lastPlayedHour: 9
  },
  {
    track: { id: 2, title: "Late Night Calm", artists: ["Artist B"], moodTag: "night" },
    likedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    playCount: 25,
    lastPlayedHour: 23
  }
];

describe("TasteEngine", () => {
  it("aggregates by play count, recency and period", () => {
    const engine = new TasteEngine();
    const events: PlayEvent[] = [];
    const profile = engine.generate(baseStats, events);

    expect(profile.topArtists[0]?.name).toBe("Artist A");
    expect(profile.favoritePeriods[0]?.period).toBe("morning");
    expect(profile.moodWeights.focus).toBeGreaterThan(profile.moodWeights.night);
  });

  it("downgrades period weight when skip events accumulate", () => {
    const engine = new TasteEngine();
    const events: PlayEvent[] = [
      { type: "skip", trackId: 1, at: new Date("2026-04-23T09:00:00.000Z").toISOString() },
      { type: "skip", trackId: 3, at: new Date("2026-04-23T09:30:00.000Z").toISOString() }
    ];
    const profile = engine.generate(baseStats, events);
    const morning = profile.favoritePeriods.find((period) => period.period === "morning");

    expect(morning?.weight).toBeLessThan(0.95);
  });
});
