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

  it("does not learn tags, periods, or pacing from raw playback outcomes", () => {
    const engine = new TasteEngine();
    const stats: TrackStat[] = [
      {
        track: {
          id: 101,
          title: "Morning Rock",
          artists: ["Artist A"],
          tags: [{ category: "style", value: "摇滚" }]
        },
        playCount: 10,
        lastPlayedHour: 9
      },
      {
        track: {
          id: 102,
          title: "Night Jazz",
          artists: ["Artist B"],
          tags: [{ category: "style", value: "爵士" }]
        },
        playCount: 10,
        lastPlayedHour: 23
      }
    ];
    const startedAt = new Date(2026, 7, 25, 9).toISOString();
    const factualEvents: PlayEvent[] = [
      { type: "play_start", trackId: 101, at: startedAt }
    ];
    const rawOutcomes: PlayEvent[] = [
      { type: "replay", trackId: 102, at: startedAt },
      { type: "complete", trackId: 102, at: startedAt },
      { type: "skip", trackId: 101, at: startedAt },
      { type: "abandoned", trackId: 101, at: startedAt },
      { type: "playback_error", trackId: 102, at: startedAt }
    ];

    const factualProfile = engine.generate(stats, factualEvents);
    const profileWithRawOutcomes = engine.generate(stats, [...factualEvents, ...rawOutcomes]);

    expect(profileWithRawOutcomes.preferenceTags).toEqual(factualProfile.preferenceTags);
    expect(profileWithRawOutcomes.favoritePeriods).toEqual(factualProfile.favoritePeriods);
    expect(profileWithRawOutcomes.pacingPreference).toBe(factualProfile.pacingPreference);
  });

  it("builds weighted artist, style, period, weather, and scene tags from a local favorite", () => {
    const favoritedAt = new Date().toISOString();
    const engine = new TasteEngine();
    const profile = engine.generate(
      [
        {
          track: {
            id: 10,
            title: "Blue Train",
            artists: ["Coltrane"],
            moodTag: "calm",
            tags: [{ category: "style", value: "爵士" }]
          },
          localFavoritedAt: favoritedAt,
          playCount: 0,
          lastPlayedHour: 23
        }
      ],
      [
        {
          type: "like",
          trackId: 10,
          at: favoritedAt,
          metadata: {
            period: "深夜",
            weather: "雨天",
            contextTags: "学习工作"
          }
        }
      ]
    );

    expect(profile.preferenceTags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "artist", value: "Coltrane" }),
        expect.objectContaining({ category: "style", value: "爵士" }),
        expect.objectContaining({ category: "period", value: "深夜" }),
        expect.objectContaining({ category: "weather", value: "雨天" }),
        expect.objectContaining({ category: "scene", value: "学习工作" })
      ])
    );
  });

  it("removes the active favorite boost after unfavoriting", () => {
    const engine = new TasteEngine();
    const stats: TrackStat[] = [{
      track: {
        id: 12,
        title: "Fresh Metal",
        artists: ["Band"],
        tags: [{ category: "style", value: "金属" }]
      },
      playCount: 0
    }];

    const profile = engine.generate(stats, [
      { type: "unlike", trackId: 12, at: new Date().toISOString() }
    ]);

    expect(profile.preferenceTags.find((tag) => tag.value === "金属")).toBeUndefined();
  });
});
