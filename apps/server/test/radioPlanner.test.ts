import { describe, expect, it } from "vitest";

import type {
  PlayEvent,
  RecommendationCandidate,
  TasteProfile,
  TrackStat
} from "@musicgpt/shared";
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
  preferenceTags: [],
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

  it("uses graded skip cooldowns and lets a later positive event restore a track", () => {
    const planner = new RadioPlanner(() => 0.5);
    const now = Date.now();
    const feedbackStats: TrackStat[] = [
      { track: { id: 11, title: "One Skip", artists: ["A"] }, playCount: 100 },
      {
        track: { id: 12, title: "Two Skips", artists: ["B"] },
        playCount: 90,
        localFavoritedAt: new Date(now - 5_000).toISOString()
      },
      { track: { id: 13, title: "Restored", artists: ["C"] }, playCount: 80 },
      { track: { id: 14, title: "Steady", artists: ["D"] }, playCount: 10 }
    ];
    const events: PlayEvent[] = [
      { type: "play", trackId: 13, at: new Date(now - 1_000).toISOString() },
      { type: "skip", trackId: 11, at: new Date(now - 2_000).toISOString() },
      { type: "skip", trackId: 12, at: new Date(now - 3_000).toISOString() },
      { type: "skip", trackId: 12, at: new Date(now - 4_000).toISOString() },
      { type: "skip", trackId: 13, at: new Date(now - 5_000).toISOString() },
      { type: "skip", trackId: 13, at: new Date(now - 6_000).toISOString() }
    ];

    const plan = planner.plan(feedbackStats, profile, events, { windowSize: 4 });

    expect(plan.map((item) => item.track.id)).toContain(11);
    expect(plan.map((item) => item.track.id)).not.toContain(12);
    expect(plan.map((item) => item.track.id)).toContain(13);
    expect(plan.findIndex((item) => item.track.id === 11)).toBeGreaterThan(
      plan.findIndex((item) => item.track.id === 14)
    );
  });

  it("boosts rainy-night friendly moods from environment context", () => {
    const planner = new RadioPlanner(() => 0.5);
    const plan = planner.plan(stats, profile, [], {
      environment: {
        dayPeriod: "late_night",
        weather: "rain",
        temperature: 18,
        location: { latitude: 31.23, longitude: 121.47, label: "Shanghai" },
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan[0]?.track.id).toBe(2);
    expect(plan[0]?.reason).toContain("雨天");
    expect(plan[0]?.reason).toContain("深夜");
  });

  it("caps a ten-track window at two qualified exploration picks", () => {
    const planner = new RadioPlanner(() => 0.5);
    const familiarStats: TrackStat[] = Array.from({ length: 10 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Familiar ${index + 1}`,
        artists: [`Known ${index + 1}`],
        moodTag: "warm"
      },
      playCount: 20 - index
    }));
    const candidates: RecommendationCandidate[] = Array.from({ length: 6 }, (_, index) => ({
      track: {
        id: 100 + index,
        title: `Explore ${index + 1}`,
        artists: [`New ${index + 1}`],
        moodTag: "warm"
      },
      source: index % 2 === 0 ? "ncm_daily" : "style_search",
      tags: [{ category: "style", value: `Style ${index + 1}` }],
      relevanceScore: 1 - index * 0.05,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates,
      environment: {
        dayPeriod: "evening",
        weather: "clear",
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan).toHaveLength(10);
    expect(plan.filter((item) => item.bucket === "familiar")).toHaveLength(8);
    expect(plan.filter((item) => item.bucket === "explore")).toHaveLength(2);
    expect(plan.map((item) => item.bucket)).toEqual([
      "familiar", "familiar", "familiar", "familiar", "explore",
      "familiar", "familiar", "familiar", "familiar", "explore"
    ]);
  });

  it("does not force a weak search candidate into an otherwise healthy queue", () => {
    const planner = new RadioPlanner(() => 0);
    const familiarStats: TrackStat[] = Array.from({ length: 10 }, (_, index) => ({
      track: { id: index + 1, title: `Known ${index + 1}`, artists: [`Artist ${index + 1}`] },
      playCount: 20 - index
    }));
    const weakCandidate: RecommendationCandidate = {
      track: { id: 300, title: "Unrelated Result", artists: ["Remote Artist"], moodTag: "unknown" },
      source: "context_search",
      tags: [],
      relevanceScore: 0.6,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates: [weakCandidate],
      environment: {
        dayPeriod: "afternoon",
        weather: "storm",
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan).toHaveLength(10);
    expect(plan.every((item) => item.bucket === "familiar")).toBe(true);
  });

  it("uses daily recommendations for bootstrap without letting broad search exceed twenty percent", () => {
    const planner = new RadioPlanner(() => 0.5);
    const familiarStats: TrackStat[] = Array.from({ length: 2 }, (_, index) => ({
      track: { id: index + 1, title: `Known ${index + 1}`, artists: [`Artist ${index + 1}`] },
      playCount: 2 - index
    }));
    const daily: RecommendationCandidate[] = Array.from({ length: 3 }, (_, index) => ({
      track: { id: 100 + index, title: `Daily ${index + 1}`, artists: [`Daily Artist ${index + 1}`] },
      source: "ncm_daily",
      tags: [],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const search: RecommendationCandidate[] = Array.from({ length: 6 }, (_, index) => ({
      track: { id: 200 + index, title: `Search ${index + 1}`, artists: [`Search Artist ${index + 1}`] },
      source: "context_search",
      tags: [],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates: [...daily, ...search]
    });

    expect(plan.filter((item) => item.source === "context_search").length).toBeLessThanOrEqual(2);
    expect(plan.filter((item) => item.source === "ncm_daily")).toHaveLength(3);
    expect(plan).toHaveLength(5);
  });
});
