import { currentPeriod } from "./time.js";
import { inferTrackTags, periodLabel, primaryStyle, weatherLabel } from "./trackTags.js";
import { isEligibleRecommendationTrack } from "./recommendationQuality.js";
import { getTrackKey, normalizeTrackIdentity, normalizeTrackReference } from "./musicCatalog.js";

import type {
  DayPeriod,
  EnvironmentContext,
  IntelligencePolicyMode,
  ListeningConstraint,
  MoodTag,
  MusicTag,
  PlayEvent,
  RadioPlanItem,
  RecommendationCandidate,
  RecommendationSource,
  TasteManualRules,
  TasteProfile,
  Track,
  TrackStat
} from "@musicgpt/shared";
import { ListeningPolicy, satisfiesListeningConstraints } from "./listeningPolicy.js";
import type { RankedDecision } from "./listeningPolicy.js";

interface PlanOptions {
  windowSize?: number;
  desiredMood?: string;
  environment?: EnvironmentContext;
  candidates?: RecommendationCandidate[];
  contextTags?: MusicTag[];
  allowAmbient?: boolean;
  rules?: TasteManualRules;
  sessionId?: string;
  policyMode?: IntelligencePolicyMode;
  constraints?: ListeningConstraint[];
  onPolicyError?: (error: unknown) => void;
  onShadowRanking?: (decisions: RankedDecision[]) => void;
}

interface ScoredItem extends RadioPlanItem {
  bucket: "familiar" | "explore";
  source: RecommendationSource;
}

export class RadioPlanner {
  constructor(
    private readonly random: () => number = Math.random,
    private readonly listeningPolicy = new ListeningPolicy()
  ) {}

  plan(
    stats: TrackStat[],
    profile: TasteProfile,
    events: PlayEvent[],
    options: PlanOptions = {}
  ): RadioPlanItem[] {
    const nowPeriod = options.environment?.dayPeriod ?? currentPeriod();
    const windowSize = options.windowSize ?? 10;
    const contextTags = options.contextTags ?? [];
    const policyMode = options.policyMode ?? "adaptive";
    const activeRules = options.rules ?? EMPTY_RULES;
    const candidateVariants = (options.candidates ?? []).map((candidate) => ({
      ...candidate,
      track: {
        ...candidate.track,
        tags: [...(candidate.track.tags ?? []), ...candidate.tags]
      }
    }));
    const allVariantTracks = [
      ...stats.map((entry) => entry.track),
      ...candidateVariants.map((candidate) => candidate.track)
    ];
    const blockedRecordingKeys = new Set(
      allVariantTracks
        .filter((track) => isManuallyBlocked(track, activeRules))
        .map(recordingKeyFor)
    );
    const isBlockedRecording = (track: Track): boolean =>
      blockedRecordingKeys.has(recordingKeyFor(track));
    const recordingKeyByTrackKey = new Map(
      allVariantTracks.map((track) => [getTrackKey(track), recordingKeyFor(track)])
    );
    const recordingKeyForEvent = (event: PlayEvent): string =>
      event.recordingKey ??
      recordingKeyByTrackKey.get(normalizeTrackReference(event.trackId)) ??
      normalizeTrackReference(event.trackId);
    const knownTrackKeys = new Set(stats.map((entry) => getTrackKey(entry.track)));
    const knownRecordings = new Set(stats.map((entry) => recordingKeyFor(entry.track)));
    const feedbackByRecording = buildFeedbackSignals([
      ...events,
      ...stats.flatMap((entry): PlayEvent[] => entry.localFavoritedAt
        ? [{
            type: "like",
            trackId: getTrackKey(entry.track),
            recordingKey: recordingKeyFor(entry.track),
            at: entry.localFavoritedAt
          }]
        : [])
    ], recordingKeyForEvent);
    const recentRecordingKeys = new Set(events
      .slice(0, 20)
      .filter((event) => event.type !== "playback_error")
      .map(recordingKeyForEvent));
    const recentFailedTrackKeys = new Set(events
      .slice(0, 20)
      .filter((event) => event.type === "playback_error")
      .map((event) => normalizeTrackReference(event.trackId)));
    const wasRecentlyPlayed = (track: Track): boolean =>
      recentRecordingKeys.has(recordingKeyFor(track)) || recentFailedTrackKeys.has(getTrackKey(track));
    const maxPlayCount = stats.reduce((max, item) => Math.max(max, item.playCount), 1);
    const periodWeights = this.periodWeightLookup(profile.favoritePeriods);
    const profileTagWeights = new Map(
      profile.preferenceTags.map((tag) => [`${tag.category}:${tag.value.toLowerCase()}`, tag.weight])
    );
    const legacyFamiliar = dedupeScoredRecordings(stats
      .filter((entry) => satisfiesListeningConstraints(entry.track, options.constraints))
      .filter((entry) => isEligibleRecommendationTrack(entry.track, options.allowAmbient))
      .filter((entry) => !isBlockedRecording(entry.track))
      .filter((entry) => !feedbackByRecording.get(recordingKeyFor(entry.track))?.hidden)
      .map((entry) => applyManualRuleWeight(this.scoreTrack({
        track: entry.track,
        bucket: "familiar",
        source: "library",
        profileTagWeights,
        contextTags,
        environment: options.environment,
        desiredMood: options.desiredMood,
        nowPeriod,
        periodWeights,
        familiarScore: (entry.localFavoritedAt ? 1 : 0) * 0.55 + normalize(entry.playCount, maxPlayCount) * 0.45,
        relevanceScore: 0,
        feedbackMultiplier: feedbackByRecording.get(recordingKeyFor(entry.track))?.multiplier ?? 1,
        recentlyPlayed: wasRecentlyPlayed(entry.track)
      }), activeRules)));
    const legacyExplore = dedupeScoredRecordings(candidateVariants
      .filter((entry) => satisfiesListeningConstraints(entry.track, options.constraints))
      .filter((candidate) => !knownRecordings.has(recordingKeyFor(candidate.track)))
      .filter((candidate) => !feedbackByRecording.get(recordingKeyFor(candidate.track))?.hidden)
      .filter((candidate) => !isBlockedRecording(candidate.track))
      .filter((candidate) => candidate.relevanceScore >= 0.6)
      .filter((candidate) => isEligibleRecommendationTrack(candidate.track, options.allowAmbient))
      .map((candidate) => applyManualRuleWeight(this.scoreTrack({
        track: candidate.track,
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
        feedbackMultiplier: feedbackByRecording.get(recordingKeyFor(candidate.track))?.multiplier ?? 1,
        recentlyPlayed: wasRecentlyPlayed(candidate.track)
      }), activeRules))
      .filter((item) => item.source === "ncm_daily" || item.score >= 0.35));
    const qualifiedCandidates = candidateVariants
      .filter((candidate) => !knownTrackKeys.has(getTrackKey(candidate.track)))
      .filter((candidate) => !isBlockedRecording(candidate.track))
      .filter((candidate) => candidate.relevanceScore >= (candidate.source === "ncm_daily" ? 0.6 : 0.65));
    let effectivePolicyMode = policyMode;
    let decisions = [] as ReturnType<ListeningPolicy["rank"]>;
    if (policyMode !== "legacy") {
      try {
        decisions = this.listeningPolicy.rank({
          stats: stats.filter((entry) => !isBlockedRecording(entry.track)),
          candidates: qualifiedCandidates,
          profile,
          rules: activeRules,
          events,
          ...(options.allowAmbient !== undefined ? { allowAmbient: options.allowAmbient } : {}),
          random: this.random,
          context: {
            constraints: options.constraints ?? [],
            period: nowPeriod,
            ...(options.environment ? { weather: options.environment.weather } : {}),
            ...(options.desiredMood ? { desiredMood: options.desiredMood } : {}),
            ...(contextTags.length > 0 ? { contextTags } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {})
          }
        });
      } catch (error) {
        effectivePolicyMode = "legacy";
        options.onPolicyError?.(error);
      }
    }
    if (policyMode === "shadow") {
      options.onShadowRanking?.(decisions);
    }
    const policyScored = decisions.map((decision): ScoredItem => {
      const bucket = knownRecordings.has(decision.recordingKey) ? "familiar" : "explore";
      const contextReason = options.environment
        ? [
            options.environment.weather === "unknown" ? undefined : weatherLabel(options.environment.weather),
            periodLabel(nowPeriod)
          ].filter(Boolean).join(" + ")
        : periodLabel(nowPeriod);
      const sourceReason = bucket === "explore"
        ? `探索新风格 · ${sourceLabel(decision.source)}`
        : "熟悉偏好";
      return {
        track: { ...decision.track, tags: inferTrackTags(decision.track) },
        score: decision.score,
        reason: `${contextReason} + ${sourceReason}`,
        bucket,
        source: decision.source,
        decisionId: decision.decisionId,
        evidence: decision.evidence,
        policyVersion: decision.policyVersion
      };
    });
    const hasTargetingContext = Boolean(options.environment || options.desiredMood || contextTags.length > 0);
    const familiar = effectivePolicyMode === "adaptive"
      ? policyScored.filter((item) => item.bucket === "familiar")
      : legacyFamiliar;
    const explore = effectivePolicyMode === "adaptive"
      ? policyScored.filter((item) =>
          item.bucket === "explore" && (item.source === "ncm_daily" || hasTargetingContext)
        )
      : legacyExplore;

    familiar.sort((left, right) => right.score - left.score);
    explore.sort((left, right) => right.score - left.score);

    const output: ScoredItem[] = [];
    const selectedRecordingKeys = new Set<string>();
    const normalExploreLimit = Math.floor(windowSize * 0.2);
    const bootstrap = familiar.length < windowSize - normalExploreLimit;
    const dailyExplore = explore.filter((item) => item.source === "ncm_daily");
    const searchExplore = explore.filter((item) => item.source !== "ncm_daily");
    const allowedExplore = bootstrap
      ? [...dailyExplore, ...searchExplore.slice(0, normalExploreLimit)]
          .sort((left, right) => right.score - left.score)
      : explore.slice(0, normalExploreLimit);

    if (bootstrap) {
      appendDiverse(familiar, output, selectedRecordingKeys, windowSize);
      appendDiverse(allowedExplore, output, selectedRecordingKeys, windowSize);
    } else {
      for (let index = 0; index < windowSize; index += 1) {
        const scheduledExplore = (index + 1) % 5 === 0;
        const primary = scheduledExplore ? allowedExplore : familiar;
        const fallback = scheduledExplore ? familiar : undefined;
        const picked = pickDiverse(primary, output, selectedRecordingKeys) ??
          (fallback ? pickDiverse(fallback, output, selectedRecordingKeys) : undefined);
        if (!picked) {
          break;
        }
        output.push(picked);
        selectedRecordingKeys.add(recordingKeyFor(picked.track));
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

const EMPTY_RULES: TasteManualRules = {
  artistWeights: {},
  tagWeights: {},
  blockedArtists: [],
  blockedTags: []
};

function isManuallyBlocked(track: Track, rules: TasteManualRules): boolean {
  const artists = new Set(rules.blockedArtists.map((artist) => artist.toLowerCase()));
  if (track.artists.some((artist) => artists.has(artist.toLowerCase()))) return true;
  const blockedTags = new Set(rules.blockedTags.map((tag) => tag.toLowerCase()));
  return manualRuleTags(track).some((tag) =>
    blockedTags.has(tag.value.toLowerCase()) ||
    blockedTags.has(`${tag.category}:${tag.value}`.toLowerCase())
  );
}

function manualRuleTags(track: Track): MusicTag[] {
  return [
    ...inferTrackTags(track),
    ...(track.tagEvidence ?? [])
      .filter((tag) => tag.confidence >= 0.55)
      .map(({ category, value }) => ({ category, value }))
  ];
}

function applyManualRuleWeight(item: ScoredItem, rules: TasteManualRules): ScoredItem {
  let multiplier = 1;
  for (const artist of item.track.artists) {
    const configured = Object.entries(rules.artistWeights)
      .find(([key]) => key.toLowerCase() === artist.toLowerCase())?.[1];
    multiplier *= configured ?? 1;
  }
  const uniqueTags = new Map(inferTrackTags(item.track).map((tag) => [
    `${tag.category}:${tag.value.toLowerCase()}`,
    tag
  ]));
  for (const tag of uniqueTags.values()) {
    multiplier *= rules.tagWeights[`${tag.category}:${tag.value}`] ??
      rules.tagWeights[`${tag.category}:${tag.value.toLowerCase()}`] ??
      rules.tagWeights[tag.value] ?? 1;
  }
  return { ...item, score: Number((item.score * multiplier).toFixed(4)) };
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
  selectedRecordingKeys: Set<string>
): ScoredItem | undefined {
  const candidates = pool.filter((item) => !selectedRecordingKeys.has(recordingKeyFor(item.track)));
  return (
    candidates.find((item) => respectsArtist(item, output) && respectsStyleWindow(item, output)) ??
    candidates.find((item) => respectsArtist(item, output)) ??
    candidates[0]
  );
}

function dedupeScoredRecordings(items: ScoredItem[]): ScoredItem[] {
  const bestByRecording = new Map<string, ScoredItem>();
  for (const item of items) {
    const recordingKey = recordingKeyFor(item.track);
    const current = bestByRecording.get(recordingKey);
    if (!current || item.score > current.score) {
      bestByRecording.set(recordingKey, item);
    }
  }
  return [...bestByRecording.values()];
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
  selectedRecordingKeys: Set<string>,
  limit: number
): void {
  while (output.length < limit) {
    const picked = pickDiverse(pool, output, selectedRecordingKeys);
    if (!picked) {
      return;
    }
    output.push(picked);
    selectedRecordingKeys.add(recordingKeyFor(picked.track));
  }
}

function recordingKeyFor(track: Track): string {
  return normalizeTrackIdentity(track).recordingKey!;
}

function buildFeedbackSignals(
  events: PlayEvent[],
  recordingKeyForEvent: (event: PlayEvent) => string
): Map<string, { hidden: boolean; multiplier: number }> {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const grouped = new Map<string, PlayEvent[]>();
  for (const event of events) {
    const at = new Date(event.at).getTime();
    if (!Number.isFinite(at) || at < ninetyDaysAgo) {
      continue;
    }
    const recordingKey = recordingKeyForEvent(event);
    const trackEvents = grouped.get(recordingKey) ?? [];
    trackEvents.push(event);
    grouped.set(recordingKey, trackEvents);
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
