import { currentPeriod } from "./time.js";
import { inferTrackTags, periodLabel, primaryStyle, weatherLabel } from "./trackTags.js";
import { isEligibleRecommendationTrack } from "./recommendationQuality.js";
import { getTrackKey, normalizeTrackReference } from "./musicCatalog.js";

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
  allowAmbient?: boolean;
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
    const feedbackByTrack = buildFeedbackSignals([
      ...events,
      ...stats.flatMap((entry): PlayEvent[] => entry.localFavoritedAt
        ? [{ type: "like", trackId: entry.track.id, at: entry.localFavoritedAt }]
        : [])
    ]);
    const recentPlayIds = new Set(
      events.slice(0, 20).map((event) => normalizeTrackReference(event.trackId))
    );
    const maxPlayCount = stats.reduce((max, item) => Math.max(max, item.playCount), 1);
    const periodWeights = this.periodWeightLookup(profile.favoritePeriods);
    const profileTagWeights = new Map(
      profile.preferenceTags.map((tag) => [`${tag.category}:${tag.value.toLowerCase()}`, tag.weight])
    );
    const contextTags = options.contextTags ?? [];

    const familiar = stats
      .filter((entry) => isEligibleRecommendationTrack(entry.track, options.allowAmbient))
      .filter((entry) => !feedbackByTrack.get(getTrackKey(entry.track))?.hidden)
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
          relevanceScore: 0,
          feedbackMultiplier: feedbackByTrack.get(getTrackKey(entry.track))?.multiplier ?? 1,
          recentlyPlayed: recentPlayIds.has(getTrackKey(entry.track))
        })
      );

    const knownIds = new Set(stats.map((entry) => getTrackKey(entry.track)));
    const explore = (options.candidates ?? [])
      .filter((candidate) => !knownIds.has(getTrackKey(candidate.track)))
      .filter((candidate) => !feedbackByTrack.get(getTrackKey(candidate.track))?.hidden)
      .filter((candidate) => candidate.relevanceScore >= 0.6)
      .filter((candidate) => isEligibleRecommendationTrack(candidate.track, options.allowAmbient))
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
          familiarScore: 0,
          relevanceScore: candidate.relevanceScore,
          feedbackMultiplier: feedbackByTrack.get(getTrackKey(candidate.track))?.multiplier ?? 1,
          recentlyPlayed: recentPlayIds.has(getTrackKey(candidate.track))
        })
      )
      .filter((item) => item.source === "ncm_daily" || item.score >= 0.35);

    familiar.sort((left, right) => right.score - left.score);
    explore.sort((left, right) => right.score - left.score);

    const output: ScoredItem[] = [];
    const selectedIds = new Set<string>();
    const normalExploreLimit = Math.floor(windowSize * 0.2);
    const bootstrap = familiar.length < windowSize - normalExploreLimit;
    const dailyExplore = explore.filter((item) => item.source === "ncm_daily");
    const searchExplore = explore.filter((item) => item.source !== "ncm_daily");
    const allowedExplore = bootstrap
      ? [...dailyExplore, ...searchExplore.slice(0, normalExploreLimit)]
          .sort((left, right) => right.score - left.score)
      : explore.slice(0, normalExploreLimit);

    if (bootstrap) {
      appendDiverse(familiar, output, selectedIds, windowSize);
      appendDiverse(allowedExplore, output, selectedIds, windowSize);
    } else {
      for (let index = 0; index < windowSize; index += 1) {
        const scheduledExplore = (index + 1) % 5 === 0;
        const primary = scheduledExplore ? allowedExplore : familiar;
        const fallback = scheduledExplore ? familiar : undefined;
        const picked = pickDiverse(primary, output, selectedIds) ??
          (fallback ? pickDiverse(fallback, output, selectedIds) : undefined);
        if (!picked) {
          break;
        }
        output.push(picked);
        selectedIds.add(getTrackKey(picked.track));
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
    relevanceScore: number;
    feedbackMultiplier: number;
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
      contextScore * 0.3 +
      Math.max(tasteScore, periodScore * 0.35) * 0.25 +
      input.familiarScore * 0.2 +
      sourceScore * 0.1 +
      input.relevanceScore * 0.1 +
      jitter * 0.05;
    const score = rawScore * input.feedbackMultiplier * (input.recentlyPlayed ? 0.08 : 1);
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
  selectedIds: Set<string>
): ScoredItem | undefined {
  const candidates = pool.filter((item) => !selectedIds.has(getTrackKey(item.track)));
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

function appendDiverse(
  pool: ScoredItem[],
  output: ScoredItem[],
  selectedIds: Set<string>,
  limit: number
): void {
  while (output.length < limit) {
    const picked = pickDiverse(pool, output, selectedIds);
    if (!picked) {
      return;
    }
    output.push(picked);
    selectedIds.add(getTrackKey(picked.track));
  }
}

function buildFeedbackSignals(events: PlayEvent[]): Map<string, { hidden: boolean; multiplier: number }> {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const grouped = new Map<string, PlayEvent[]>();
  for (const event of events) {
    const at = new Date(event.at).getTime();
    if (!Number.isFinite(at) || at < ninetyDaysAgo) {
      continue;
    }
    const trackKey = normalizeTrackReference(event.trackId);
    const trackEvents = grouped.get(trackKey) ?? [];
    trackEvents.push(event);
    grouped.set(trackKey, trackEvents);
  }

  const result = new Map<string, { hidden: boolean; multiplier: number }>();
  for (const [trackId, trackEvents] of grouped) {
    const ordered = [...trackEvents].sort(
      (left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()
    );
    const latestPositiveAt = ordered
      .filter((event) =>
        event.type === "play" ||
        event.type === "complete" ||
        event.type === "replay" ||
        event.type === "like"
      )
      .reduce((latest, event) => Math.max(latest, new Date(event.at).getTime()), Number.NEGATIVE_INFINITY);
    const skipsSincePositive = ordered.filter((event) =>
      event.type === "skip" && new Date(event.at).getTime() > latestPositiveAt
    );
    result.set(trackId, {
      hidden: skipsSincePositive.length >= 2,
      multiplier: skipsSincePositive.length === 1 &&
        new Date(skipsSincePositive[0]!.at).getTime() >= thirtyDaysAgo
        ? 0.15
        : 1
    });
  }
  return result;
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
