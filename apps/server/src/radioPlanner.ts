import { currentPeriod } from "./time.js";
import { inferTrackTags, periodLabel, primaryStyle, weatherLabel } from "./trackTags.js";

import type {
  DayPeriod,
  EnvironmentContext,
  MoodTag,
  MusicTag,
  PlayEvent,
  RadioPlanItem,
  RecommendationCandidate,
  RecommendationSource,
  TasteProfile,
  Track,
  TrackStat
} from "@musicgpt/shared";

interface PlanOptions {
  windowSize?: number;
  desiredMood?: string;
  environment?: EnvironmentContext;
  candidates?: RecommendationCandidate[];
  contextTags?: MusicTag[];
}

interface ScoredItem extends RadioPlanItem {
  bucket: "familiar" | "explore";
  source: RecommendationSource;
}

export class RadioPlanner {
  constructor(private readonly random: () => number = Math.random) {}

  plan(
    stats: TrackStat[],
    profile: TasteProfile,
    events: PlayEvent[],
    options: PlanOptions = {}
  ): RadioPlanItem[] {
    const nowPeriod = options.environment?.dayPeriod ?? currentPeriod();
    const windowSize = options.windowSize ?? 10;
    const recentSkipIds = new Set(
      events.filter((event) => event.type === "skip").slice(0, 12).map((event) => event.trackId)
    );
    const recentPlayIds = new Set(events.slice(0, 20).map((event) => event.trackId));
    const maxPlayCount = stats.reduce((max, item) => Math.max(max, item.playCount), 1);
    const periodWeights = this.periodWeightLookup(profile.favoritePeriods);
    const profileTagWeights = new Map(
      profile.preferenceTags.map((tag) => [`${tag.category}:${tag.value.toLowerCase()}`, tag.weight])
    );
    const contextTags = options.contextTags ?? [];

    const familiar = stats
      .filter((entry) => !recentSkipIds.has(entry.track.id))
      .map((entry) =>
        this.scoreTrack({
          track: entry.track,
          bucket: "familiar",
          source: "library",
          profileTagWeights,
          contextTags,
          environment: options.environment,
          desiredMood: options.desiredMood,
          nowPeriod,
          periodWeights,
          familiarScore:
            (entry.localFavoritedAt ? 1 : 0) * 0.55 +
            normalize(entry.playCount, maxPlayCount) * 0.45,
          recentlyPlayed: recentPlayIds.has(entry.track.id)
        })
      );

    const knownIds = new Set(stats.map((entry) => entry.track.id));
    const explore = (options.candidates ?? [])
      .filter((candidate) => !knownIds.has(candidate.track.id))
      .filter((candidate) => !recentSkipIds.has(candidate.track.id))
      .map((candidate) =>
        this.scoreTrack({
          track: { ...candidate.track, tags: candidate.tags },
          bucket: "explore",
          source: candidate.source,
          profileTagWeights,
          contextTags,
          environment: options.environment,
          desiredMood: options.desiredMood,
          nowPeriod,
          periodWeights,
          familiarScore: 1,
          recentlyPlayed: recentPlayIds.has(candidate.track.id)
        })
      );

    familiar.sort((left, right) => right.score - left.score);
    explore.sort((left, right) => right.score - left.score);

    const familiarTarget = Math.ceil(windowSize / 2);
    const exploreTarget = Math.floor(windowSize / 2);
    const output: ScoredItem[] = [];
    const selectedIds = new Set<number>();
    let familiarUsed = 0;
    let exploreUsed = 0;

    while (output.length < windowSize) {
      const preferExplore = output.length % 2 === 1;
      const pool =
        preferExplore && exploreUsed < exploreTarget
          ? explore
          : !preferExplore && familiarUsed < familiarTarget
            ? familiar
            : exploreUsed < exploreTarget
              ? explore
              : familiar;
      const picked = pickDiverse(pool, output, selectedIds);
      if (!picked) {
        const fallbackPool = pool === familiar ? explore : familiar;
        const fallback = pickDiverse(fallbackPool, output, selectedIds);
        if (!fallback) {
          break;
        }
        output.push(fallback);
        selectedIds.add(fallback.track.id);
        if (fallback.bucket === "explore") {
          exploreUsed += 1;
        } else {
          familiarUsed += 1;
        }
        continue;
      }
      output.push(picked);
      selectedIds.add(picked.track.id);
      if (picked.bucket === "explore") {
        exploreUsed += 1;
      } else {
        familiarUsed += 1;
      }
    }
    return output;
  }

  private scoreTrack(input: {
    track: Track;
    bucket: "familiar" | "explore";
    source: RecommendationSource;
    profileTagWeights: Map<string, number>;
    contextTags: MusicTag[];
    environment: EnvironmentContext | undefined;
    desiredMood: string | undefined;
    nowPeriod: DayPeriod;
    periodWeights: Map<DayPeriod, number>;
    familiarScore: number;
    recentlyPlayed: boolean;
  }): ScoredItem {
    const tags = inferTrackTags(input.track);
    const contextScore = calculateContextScore(
      input.track,
      tags,
      input.contextTags,
      input.environment,
      input.desiredMood
    );
    const tasteScore = Math.min(
      1,
      tags.reduce(
        (total, tag) =>
          total + (input.profileTagWeights.get(`${tag.category}:${tag.value.toLowerCase()}`) ?? 0),
        0
      ) * 3
    );
    const periodScore = input.environment
      ? environmentPeriodScore(input.track, input.nowPeriod)
      : (input.periodWeights.get(input.nowPeriod) ?? 0.25);
    const sourceScore = sourceQuality(input.source);
    const jitter = this.random();
    const rawScore =
      contextScore * 0.35 +
      Math.max(tasteScore, periodScore * 0.35) * 0.3 +
      input.familiarScore * 0.2 +
      sourceScore * 0.1 +
      jitter * 0.05;
    const score = rawScore * (input.recentlyPlayed ? 0.08 : 1);
    const contextReason = input.environment
      ? [
          input.environment.weather === "unknown" ? undefined : weatherLabel(input.environment.weather),
          periodLabel(input.nowPeriod)
        ].filter(Boolean).join(" + ")
      : periodLabel(input.nowPeriod);
    const sourceReason =
      input.bucket === "explore"
        ? `探索新风格 · ${sourceLabel(input.source)}`
        : "熟悉偏好";

    return {
      track: { ...input.track, tags },
      score: Number(score.toFixed(4)),
      reason: `${contextReason} + ${sourceReason}`,
      bucket: input.bucket,
      source: input.source
    };
  }

  private periodWeightLookup(
    periods: Array<{ period: DayPeriod; weight: number }>
  ): Map<DayPeriod, number> {
    return new Map(periods.map((item) => [item.period, item.weight]));
  }
}

function calculateContextScore(
  track: Track,
  tags: MusicTag[],
  contextTags: MusicTag[],
  environment?: EnvironmentContext,
  desiredMood?: string
): number {
  let score = 0.25;
  if (environment) {
    score = weatherMoodScore(environment.weather, track.moodTag) * 0.65 + 0.15;
  }
  if (desiredMood) {
    score += track.moodTag === desiredMood ? 0.35 : -0.1;
  }
  if (contextTags.length > 0) {
    const trackKeys = new Set(tags.map((tag) => `${tag.category}:${tag.value.toLowerCase()}`));
    const matched = contextTags.filter((tag) =>
      trackKeys.has(`${tag.category}:${tag.value.toLowerCase()}`)
    ).length;
    score += Math.min(0.35, matched * 0.14);
  }
  return clamp(score);
}

function environmentPeriodScore(track: Track, nowPeriod: DayPeriod): number {
  const tag = inferTrackTags(track).find((item) => item.category === "period");
  if (!tag) {
    return 0.5;
  }
  return tag.value === periodLabel(nowPeriod) ? 1 : 0.2;
}

function pickDiverse(
  pool: ScoredItem[],
  output: ScoredItem[],
  selectedIds: Set<number>
): ScoredItem | undefined {
  const candidates = pool.filter((item) => !selectedIds.has(item.track.id));
  return (
    candidates.find((item) => respectsArtist(item, output) && respectsStyleWindow(item, output)) ??
    candidates.find((item) => respectsArtist(item, output)) ??
    candidates[0]
  );
}

function respectsArtist(item: ScoredItem, output: ScoredItem[]): boolean {
  const previous = output.at(-1);
  if (!previous) {
    return true;
  }
  const previousArtists = new Set(previous.track.artists.map((artist) => artist.toLowerCase()));
  return !item.track.artists.some((artist) => previousArtists.has(artist.toLowerCase()));
}

function respectsStyleWindow(item: ScoredItem, output: ScoredItem[]): boolean {
  const style = primaryStyle(item.track);
  if (!style) {
    return true;
  }
  const recent = output.slice(-4);
  const count = recent.filter((entry) => primaryStyle(entry.track) === style).length;
  return count < 2;
}

function sourceQuality(source: RecommendationSource): number {
  const quality: Record<RecommendationSource, number> = {
    library: 0.85,
    ncm_daily: 1,
    context_search: 0.92,
    style_search: 0.82,
    chat_search: 0.9
  };
  return quality[source];
}

function sourceLabel(source: RecommendationSource): string {
  const labels: Record<RecommendationSource, string> = {
    library: "本地曲库",
    ncm_daily: "网易云日推",
    context_search: "当前氛围",
    style_search: "风格漫游",
    chat_search: "DJ 搜索"
  };
  return labels[source];
}

function normalize(value: number, max: number): number {
  return max <= 0 ? 0 : value / max;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function weatherMoodScore(weather: EnvironmentContext["weather"], mood: MoodTag | undefined): number {
  const value = mood ?? "unknown";
  const preferred: Record<EnvironmentContext["weather"], MoodTag[]> = {
    clear: ["energy", "warm"],
    cloudy: ["calm", "focus", "nostalgia"],
    rain: ["night", "warm", "calm"],
    snow: ["calm", "warm", "nostalgia"],
    fog: ["night", "calm", "focus"],
    storm: ["night", "energy"],
    unknown: ["unknown"]
  };
  const index = preferred[weather].indexOf(value);
  if (index === 0) {
    return 1;
  }
  if (index > 0) {
    return 0.78 - index * 0.08;
  }
  return weather === "unknown" ? 0.5 : 0.18;
}
