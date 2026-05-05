import { inferMood } from "./moodClassifier.js";
import { StateRepository } from "./stateRepository.js";

import type { EnvironmentContext, TasteProfile, Track, TrackStat } from "@musicgpt/shared";

interface SearchProvider {
  searchSongs(query: string): Promise<Track[]>;
}

export interface RecommendationImportResult {
  importedCount: number;
  skippedCount: number;
}

export class RecommendationImporter {
  constructor(
    private readonly repo: StateRepository,
    private readonly searchProvider: SearchProvider
  ) {}

  async importRecommendations(
    profile: TasteProfile,
    environment: EnvironmentContext
  ): Promise<RecommendationImportResult> {
    const existingIds = new Set(this.repo.getTrackStats(5000).map((item) => item.track.id));
    const candidates = new Map<number, Track>();
    let skippedCount = 0;

    for (const seed of buildSeeds(profile, environment)) {
      const tracks = await this.searchProvider.searchSongs(seed).catch(() => []);
      for (const track of tracks) {
        if (existingIds.has(track.id) || candidates.has(track.id)) {
          skippedCount += 1;
          continue;
        }
        candidates.set(track.id, {
          ...track,
          moodTag: track.moodTag ?? inferMood(track)
        });
      }
    }

    const stats: TrackStat[] = [...candidates.values()].map((track) => ({
      track,
      playCount: 0
    }));
    if (stats.length > 0) {
      this.repo.upsertTrackStats(stats);
    }

    return {
      importedCount: stats.length,
      skippedCount
    };
  }
}

function buildSeeds(profile: TasteProfile, environment: EnvironmentContext): string[] {
  const seeds = new Set<string>();
  const weather = weatherSeed(environment.weather, environment.dayPeriod);
  if (weather) {
    seeds.add(weather);
  }

  const period = periodSeed(environment.dayPeriod);
  if (period) {
    seeds.add(period);
  }

  for (const artist of profile.topArtists.slice(0, 3)) {
    seeds.add(`${artist.name} ${weather || period || "推荐"}`);
  }

  const topMood = Object.entries(profile.moodWeights).sort((left, right) => right[1] - left[1])[0]?.[0];
  if (topMood) {
    seeds.add(`${moodSeed(topMood)} 音乐`);
  }

  return [...seeds].slice(0, 8);
}

function weatherSeed(weather: EnvironmentContext["weather"], period: EnvironmentContext["dayPeriod"]): string {
  if (weather === "rain") {
    return period === "late_night" || period === "evening" ? "雨夜 温柔" : "雨天 治愈";
  }
  if (weather === "clear") {
    return period === "morning" ? "晴天 清晨" : "晴天 轻快";
  }
  if (weather === "cloudy" || weather === "fog") {
    return "阴天 氛围";
  }
  if (weather === "snow") {
    return "雪天 安静";
  }
  if (weather === "storm") {
    return "雷雨 夜晚";
  }
  return "";
}

function periodSeed(period: EnvironmentContext["dayPeriod"]): string {
  if (period === "morning") {
    return "早晨 轻快";
  }
  if (period === "afternoon") {
    return "下午 工作";
  }
  if (period === "evening") {
    return "傍晚 温柔";
  }
  return "深夜 安静";
}

function moodSeed(mood: string): string {
  const labels: Record<string, string> = {
    calm: "安静",
    focus: "专注",
    warm: "温柔",
    night: "夜晚",
    energy: "活力",
    nostalgia: "怀旧",
    unknown: "私人电台"
  };
  return labels[mood] ?? "私人电台";
}
