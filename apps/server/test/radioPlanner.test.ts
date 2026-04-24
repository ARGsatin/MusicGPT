import { describe, expect, it } from "vitest";

import type { PlayEvent, TasteProfile, TrackStat } from "@musicgpt/shared";
import { RadioPlanner } from "../src/radioPlanner.js";

const stats: TrackStat[] = [
  {
    track: { id: 1, title: "Morning Song", artists: ["A"], moodTag: "calm" },
    playCount: 80,
    lastPlayedHour: 8
  },
  {
    track: { id: 2, title: "Night Song", artists: ["B"], moodTag: "night" },
    playCount: 70,
    lastPlayedHour: 23
  },
  {
    track: { id: 3, title: "Focus Song", artists: ["C"], moodTag: "focus" },
    playCount: 50,
    lastPlayedHour: 10
  }
];

const profile: TasteProfile = {
  generatedAt: new Date().toISOString(),
  summary: "test",
  topArtists: [],
  topTracks: [],
  favoritePeriods: [
    { period: "morning", weight: 0.7 },
    { period: "late_night", weight: 0.1 },
    { period: "afternoon", weight: 0.1 },
    { period: "evening", weight: 0.1 }
  ],
  moodWeights: {
    calm: 0.3,
    focus: 0.3,
    warm: 0.1,
    night: 0.1,
    energy: 0.1,
    nostalgia: 0.05,
    unknown: 0.05
  },
  pacingPreference: "balanced"
};

describe("RadioPlanner", () => {
  it("returns ranked tracks with reasons", () => {
    const planner = new RadioPlanner(() => 0.5);
    const plan = planner.plan(stats, profile, []);

    expect(plan).toHaveLength(3);
    expect(plan[0]?.track.id).toBe(1);
    expect(plan[0]?.reason).toContain("偏好");
  });

  it("penalizes recently skipped songs", () => {
    const planner = new RadioPlanner(() => 0.5);
    const events: PlayEvent[] = [{ type: "skip", trackId: 1, at: new Date().toISOString() }];
    const plan = planner.plan(stats, profile, events);
    const firstId = plan[0]?.track.id;

    expect(firstId).not.toBe(1);
  });
});
