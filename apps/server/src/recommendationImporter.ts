import { inferMood } from "./moodClassifier.js";
import {
  isEligibleRecommendationTrack,
  isExplicitAmbientRequest
} from "./recommendationQuality.js";
import { StateRepository } from "./stateRepository.js";
import {
  DISCOVERY_STYLES,
  environmentTags,
  inferTrackTags,
  tagsFromContextText
} from "./trackTags.js";

import type {
  EnvironmentContext,
  RecommendationCandidate,
  TasteProfile,
  Track
} from "@musicgpt/shared";

interface SearchProvider {
  searchSongs(query: string): Promise<Track[]>;
  fetchDailyRecommendations?(): Promise<Track[]>;
}

export interface RecommendationImportResult {
  importedCount: number;
  skippedCount: number;
}

interface SearchSeed {
  query: string;
  source: "context_search" | "style_search";
}

const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export class RecommendationImporter {
  constructor(
    private readonly repo: StateRepository,
    private readonly searchProvider: SearchProvider
  ) {}

  async importRecommendations(
    profile: TasteProfile,
    environment: EnvironmentContext,
    contextText = "",
    forceDailyRefresh = false,
    includeSearch = true
  ): Promise<RecommendationImportResult> {
    this.repo.deleteExpiredRecommendationCandidates();
    const existingIds = new Set(this.repo.getTrackStats(5000).map((item) => item.track.id));

    const now = new Date();
    const discoveredAt = now.toISOString();
    const candidates = new Map<number, RecommendationCandidate>();
    const allowAmbient = isExplicitAmbientRequest(contextText);
    let skippedCount = 0;

    const dailyDate = localDateKey(now);
    const shouldRefreshDaily =
      forceDailyRefresh ||
      this.repo.getRecommendationRefreshDate("ncm_daily") !== dailyDate;
    if (shouldRefreshDaily && this.searchProvider.fetchDailyRecommendations) {
      const dailyTracks = await this.searchProvider.fetchDailyRecommendations().catch(() => []);
      for (const track of dailyTracks) {
        if (!isEligibleRecommendationTrack(track, allowAmbient)) {
          skippedCount += 1;
          continue;
        }
        skippedCount += addCandidate(candidates, existingIds, {
          track,
          source: "ncm_daily",
          tags: inferTrackTags(track),
          relevanceScore: 1,
          discoveredAt,
          expiresAt: new Date(now.getTime() + DAILY_TTL_MS).toISOString()
        });
      }
      if (dailyTracks.length > 0) {
        this.repo.saveRecommendationRefreshDate("ncm_daily", dailyDate);
      }
    }

    const seeds = includeSearch ? buildSeeds(profile, environment, contextText, now) : [];
    const batches = await Promise.all(
      seeds.map(async (seed) => ({
        seed,
        tracks: await this.searchProvider.searchSongs(seed.query).catch(() => [])
      }))
    );
    for (const { seed, tracks } of batches) {
      const eligibleTracks = tracks
        .filter((track) => isEligibleRecommendationTrack(track, allowAmbient))
        .slice(0, 3);
      skippedCount += tracks.length - eligibleTracks.length;
      for (const [index, track] of eligibleTracks.entries()) {
        const normalized = {
          ...track,
          moodTag: track.moodTag ?? inferMood(track)
        };
        const tags = inferTrackTags(normalized);
        skippedCount += addCandidate(candidates, existingIds, {
          track: { ...normalized, tags },
          source: seed.source,
          tags,
          relevanceScore: 1 - index * 0.2,
          discoveredAt,
          expiresAt: new Date(now.getTime() + SEARCH_TTL_MS).toISOString()
        });
      }
    }

    const rows = [...candidates.values()];
    this.repo.upsertRecommendationCandidates(rows);
    return {
      importedCount: rows.length,
      skippedCount
    };
  }
}

function addCandidate(
  candidates: Map<number, RecommendationCandidate>,
  existingIds: Set<number>,
  candidate: RecommendationCandidate
): number {
  if (existingIds.has(candidate.track.id) || candidates.has(candidate.track.id)) {
    const existing = candidates.get(candidate.track.id);
    if (existing && candidate.relevanceScore > existing.relevanceScore) {
      candidates.set(candidate.track.id, candidate);
    }
    return 1;
  }
  candidates.set(candidate.track.id, candidate);
  return 0;
}

function buildSeeds(
  profile: TasteProfile,
  environment: EnvironmentContext,
  contextText: string,
  now: Date
): SearchSeed[] {
  const seeds = new Map<string, SearchSeed>();
  const contextTags = [
    ...environmentTags(environment),
    ...tagsFromContextText(contextText)
  ];
  const atmosphere = [
    atmosphereSeed(environment),
    contextTags.find((tag) => tag.category === "scene")?.value ?? ""
  ].filter(Boolean).join(" ");
  if (atmosphere) {
    seeds.set(atmosphere, {
      query: atmosphere,
      source: "context_search"
    });
  }

  for (const artist of profile.topArtists.slice(0, 2)) {
    const query = `${artist.name} ${atmosphere || "相似推荐"}`;
    seeds.set(query, {
      query,
      source: "context_search"
    });
  }

  const topTags = profile.preferenceTags
    .filter((tag) => tag.category === "style" || tag.category === "mood")
    .slice(0, 2);
  for (const tag of topTags) {
    const query = `${tag.value} ${periodSeed(environment.dayPeriod)}`;
    seeds.set(query, {
      query,
      source: "context_search"
    });
  }

  const dayIndex = dayOfYear(now);
  const discoveryIndexes = [dayIndex % DISCOVERY_STYLES.length, (dayIndex + 5) % DISCOVERY_STYLES.length];
  for (const index of discoveryIndexes) {
    const style = DISCOVERY_STYLES[index]!;
    const query = `${style} ${periodSeed(environment.dayPeriod)}`;
    seeds.set(query, {
      query,
      source: "style_search"
    });
  }
  return [...seeds.values()].slice(0, 7);
}

function weatherSeed(weather: EnvironmentContext["weather"]): string {
  const labels: Record<EnvironmentContext["weather"], string> = {
    clear: "晴天",
    cloudy: "阴天",
    rain: "雨天",
    snow: "雪天",
    fog: "雾天",
    storm: "雷雨",
    unknown: ""
  };
  return labels[weather];
}

function atmosphereSeed(environment: EnvironmentContext): string {
  if (environment.weather === "rain") {
    return environment.dayPeriod === "evening" || environment.dayPeriod === "late_night"
      ? "雨夜"
      : "雨天治愈";
  }
  return [
    environment.weather === "unknown" ? "" : weatherSeed(environment.weather),
    periodSeed(environment.dayPeriod)
  ].filter(Boolean).join(" ");
}

function periodSeed(period: EnvironmentContext["dayPeriod"]): string {
  const labels: Record<EnvironmentContext["dayPeriod"], string> = {
    morning: "清晨轻快",
    afternoon: "午后",
    evening: "傍晚",
    late_night: "深夜"
  };
  return labels[period];
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

export const recommendationInternals = {
  buildSeeds,
  localDateKey
};
