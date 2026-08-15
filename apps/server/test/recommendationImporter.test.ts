import { describe, expect, it } from "vitest";

import type { TasteProfile, TrackStat } from "@musicgpt/shared";
import { RecommendationImporter } from "../src/recommendationImporter.js";
import { StateRepository } from "../src/stateRepository.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profile: TasteProfile = {
  generatedAt: new Date().toISOString(),
  summary: "雨夜喜欢温柔流行",
  topArtists: [{ name: "陈奕迅", weight: 0.6 }],
  topTracks: [],
  favoritePeriods: [{ period: "late_night", weight: 1 }],
  moodWeights: {
    calm: 0.25,
    focus: 0.05,
    warm: 0.3,
    night: 0.25,
    energy: 0.05,
    nostalgia: 0.05,
    unknown: 0.05
  },
  preferenceTags: [],
  pacingPreference: "gentle"
};

describe("RecommendationImporter", () => {
  it("keeps only three ranked, metadata-complete, non-ambient results per search seed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-quality-recs-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const importer = new RecommendationImporter(repo, {
      searchSongs: async () => [
        { id: 10, title: "雷雨声 白噪音 ASMR", artists: ["Nature Lab"] },
        { id: 11, title: "Missing Artist", artists: [] },
        { id: 12, title: "First Real Song", artists: ["A"] },
        { id: 13, title: "Second Real Song", artists: ["B"] },
        { id: 14, title: "Third Real Song", artists: ["C"] },
        { id: 15, title: "Fourth Real Song", artists: ["D"] }
      ]
    });

    await importer.importRecommendations(
      profile,
      {
        dayPeriod: "afternoon",
        weather: "storm",
        updatedAt: new Date().toISOString()
      },
      "来点适合现在氛围的歌"
    );

    const candidates = repo.getRecommendationCandidates();
    expect(candidates.map((candidate) => candidate.track.id).sort()).toEqual([12, 13, 14]);
    expect(candidates.map((candidate) => candidate.relevanceScore).sort()).toEqual([0.6, 0.8, 1]);
    expect(candidates.every((candidate) =>
      candidate.tags.every((tag) => tag.category !== "weather" && tag.category !== "period")
    )).toBe(true);
  });

  it("allows ambient tracks only when the user explicitly asks for them", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-ambient-recs-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const importer = new RecommendationImporter(repo, {
      searchSongs: async () => [
        { id: 30, title: "夜晚雷雨声 白噪音ASMR睡眠", artists: ["Nature Lab"] }
      ]
    });
    const environment = {
      dayPeriod: "late_night" as const,
      weather: "rain" as const,
      updatedAt: new Date().toISOString()
    };

    await importer.importRecommendations(profile, environment, "来点适合雨夜氛围的歌");
    expect(repo.getRecommendationCandidates()).toHaveLength(0);

    await importer.importRecommendations(profile, environment, "播放雨声白噪音助眠");
    expect(repo.getRecommendationCandidates().map((candidate) => candidate.track.id)).toEqual([30]);
  });

  it("searches NCM seeds from environment and taste, then imports deduped candidates", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-recs-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const existing: TrackStat = {
      track: { id: 1, title: "Existing Rain", artists: ["A"], moodTag: "warm" },
      playCount: 3
    };
    repo.upsertTrackStats([existing]);

    const seenQueries: string[] = [];
    const importer = new RecommendationImporter(repo, {
      searchSongs: async (query: string) => {
        seenQueries.push(query);
        return [
          { id: 1, title: "Existing Rain", artists: ["A"] },
          { id: 20, title: "Rainy Midnight", artists: ["B"] },
          { id: 21, title: "Warm Window", artists: ["C"] }
        ];
      }
    });

    const result = await importer.importRecommendations(profile, {
      dayPeriod: "late_night",
      weather: "rain",
      temperature: 16,
      location: { latitude: 31.23, longitude: 121.47 },
      updatedAt: new Date().toISOString()
    });

    expect(seenQueries.some((query) => query.includes("雨夜"))).toBe(true);
    expect(seenQueries.some((query) => query.includes("陈奕迅"))).toBe(true);
    expect(result.importedCount).toBe(2);
    expect(result.skippedCount).toBeGreaterThan(0);
    expect(repo.getTrackStats(20).map((item) => item.track.id)).toEqual([1]);
    expect(repo.getRecommendationCandidates(20).map((item) => item.track.id)).toEqual(
      expect.arrayContaining([20, 21])
    );
  });

  it("loads NCM daily recommendations once per local day and caches their source", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-daily-recs-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    let dailyRequests = 0;
    const importer = new RecommendationImporter(repo, {
      searchSongs: async () => [],
      fetchDailyRecommendations: async () => {
        dailyRequests += 1;
        return [{ id: 501, title: "Daily Pick", artists: ["NCM"] }];
      }
    });
    const environment = {
      dayPeriod: "morning" as const,
      weather: "clear" as const,
      updatedAt: new Date().toISOString()
    };

    await importer.importRecommendations(profile, environment);
    await importer.importRecommendations(profile, environment);

    expect(dailyRequests).toBe(1);
    expect(repo.getRecommendationCandidates()).toEqual([
      expect.objectContaining({
        source: "ncm_daily",
        track: expect.objectContaining({ id: 501 })
      })
    ]);
  });
});
