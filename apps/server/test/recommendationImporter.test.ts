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
  pacingPreference: "gentle"
};

describe("RecommendationImporter", () => {
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
    expect(repo.getTrackStats(20).map((item) => item.track.id)).toEqual(expect.arrayContaining([1, 20, 21]));
  });
});
