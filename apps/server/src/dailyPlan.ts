import { createHash } from "node:crypto";

import type {
  DailyPlan,
  DailyPlanSegment,
  DayPeriod,
  EnvironmentContext,
  IntelligencePolicyMode,
  MusicTag,
  PlayEvent,
  RadioPlanItem,
  RecommendationCandidate,
  RecommendationEvidence,
  RecommendationSource,
  RoutineBlock,
  SessionIntent,
  TasteManualRules,
  TasteProfile,
  Track,
  TrackStat,
  WeatherKind
} from "@musicgpt/shared";

import { getTrackKey, normalizeTrackIdentity, normalizeTrackReference } from "./musicCatalog.js";
import { isEligibleRecommendationTrack } from "./recommendationQuality.js";
import { inferTrackTags } from "./trackTags.js";
import {
  DEFAULT_DAILY_PLAN_QUOTAS,
  ListeningPolicy,
  satisfiesListeningConstraints,
  type RankedDecision
} from "./listeningPolicy.js";

const DEFAULT_DURATION_MS = 3.5 * 60 * 1000;
const MAX_TRACKS_PER_PERIOD = 10;
const DAILY_PLAN_VERSION = 4;
type PlanPeriod = Exclude<DayPeriod, "late_night">;
const PERIODS: Array<{ period: PlanPeriod; start: string; end: string }> = [
  { period: "morning", start: "06:00", end: "12:00" },
  { period: "afternoon", start: "12:00", end: "18:00" },
  { period: "evening", start: "18:00", end: "24:00" }
];

interface RecordingFamiliarity {
  playCount: number;
  likedAt?: string;
  localFavoritedAt?: string;
  lastPlayedAt?: string;
  positiveFeedback: boolean;
  trackKeys: Set<string>;
}

interface RecordingReferenceIndex {
  canonical: Map<string, string>;
  rawAliases: Map<string, Set<string>>;
}

interface PlanCandidate {
  stat: TrackStat;
  recordingKey: string;
  explore: boolean;
  soft: boolean;
  classical: boolean;
  longTerm: boolean;
  memoryScore: number;
  decisionId?: string;
  evidence?: RecommendationEvidence[];
  policyVersion?: string;
  recommendationSource?: RecommendationSource;
}

interface RankedCandidate extends PlanCandidate {
  score: number;
  tie: string;
}

export interface DailyPlanGenerateInput {
  date: string;
  timezone: string;
  stats: TrackStat[];
  profile: TasteProfile;
  rules: TasteManualRules;
  routine: RoutineBlock[];
  weather: Pick<EnvironmentContext, "weather" | "temperature">;
  weatherByPeriod?: Partial<Record<DayPeriod, Pick<EnvironmentContext, "weather" | "temperature">>>;
  previous?: DailyPlan;
  consumedTrackKeys?: string[];
  currentTrackKey?: string;
  feedback?: PlayEvent[];
  candidates?: RecommendationCandidate[];
  desiredMood?: string;
  sessionIntent?: SessionIntent;
  sessionId?: string;
  policyMode?: IntelligencePolicyMode;
  onPolicyError?: (error: unknown) => void;
  onShadowRanking?: (period: PlanPeriod, decisions: RankedDecision[]) => void;
}

export class DailyPlanEngine {
  constructor(private readonly listeningPolicy = new ListeningPolicy()) {}

  generate(input: DailyPlanGenerateInput): DailyPlan {
    const generatedAt = new Date().toISOString();
    const policyMode = input.policyMode ?? "adaptive";
    const policyProfile = this.listeningPolicy.profile();
    const quotas = policyMode === "adaptive"
      ? policyProfile.quotas
      : { ...DEFAULT_DAILY_PLAN_QUOTAS };
    const contextHash = hash(JSON.stringify({
      plannerVersion: DAILY_PLAN_VERSION,
      policyMode,
      quotas,
      date: input.date,
      timezone: input.timezone,
      weather: input.weather,
      weatherByPeriod: input.weatherByPeriod,
      routine: input.routine,
      rules: input.rules,
      desiredMood: input.desiredMood,
      sessionIntent: input.sessionIntent,
      policySignals: policyMode === "adaptive"
        ? policyProfile.signals.map((signal) =>
            `${signal.signalId}:${signal.updatedAt}:${signal.reversedAt ?? ""}:${signal.value ?? signal.strength}`
          )
        : [],
      library: input.stats.map((stat) => `${getTrackKey(stat.track)}:${stat.playCount}`),
      candidates: (input.candidates ?? []).map((candidate) =>
        `${getTrackKey(candidate.track)}:${candidate.source}:${candidate.relevanceScore}`
      ),
      feedback: (input.feedback ?? [])
        .filter((event) => !["impression", "play_start", "play"].includes(event.type))
        .slice(0, 200)
        .map((event) => `${event.trackId}:${event.type}:${event.at}`)
    }));
    const previousIsSameDay = input.previous?.date === input.date;
    const consumed = new Set(
      previousIsSameDay || !input.previous
        ? (input.consumedTrackKeys ?? input.previous?.consumedTrackKeys ?? [])
        : []
    );
    const lockedTrackKeys = new Set(consumed);
    if (input.currentTrackKey) lockedTrackKeys.add(input.currentTrackKey);
    const usedRecordings = new Set<string>();
    const recentArtists: string[] = [];
    const libraryStats = input.stats
      .map((stat) => ({ ...stat, track: normalizeTrackIdentity(stat.track) }));
    const libraryTrackKeys = new Set(libraryStats.map((stat) => getTrackKey(stat.track)));
    const recommendationSourceByTrackKey = new Map<string, RecommendationSource>();
    const normalizedCandidates = (input.candidates ?? [])
      .map((candidate): RecommendationCandidate => ({
        ...candidate,
        track: normalizeTrackIdentity({
          ...candidate.track,
          tags: [...(candidate.track.tags ?? []), ...candidate.tags]
        }),
        tags: [...(candidate.track.tags ?? []), ...candidate.tags]
      }));
    const candidateStats = normalizedCandidates
      .filter((candidate) => !libraryTrackKeys.has(getTrackKey(candidate.track)))
      .map((candidate): TrackStat => {
        recommendationSourceByTrackKey.set(getTrackKey(candidate.track), candidate.source);
        return { track: candidate.track, playCount: 0 };
      });
    const allNormalizedStats = [...libraryStats, ...candidateStats];
    const blockedRecordingKeys = new Set(
      allNormalizedStats
        .filter((stat) => isBlocked(stat.track, input.rules))
        .map((stat) => stat.track.recordingKey!)
    );
    const policyStats = allNormalizedStats
      .filter((stat) => !blockedRecordingKeys.has(stat.track.recordingKey!));
    const policyCandidates = normalizedCandidates
      .filter((candidate) => !blockedRecordingKeys.has(candidate.track.recordingKey!));
    const recordingReferences = buildRecordingReferenceIndex(allNormalizedStats);
    // Legacy/shadow keep their historical comparator. Adaptive ranking learns
    // from reversible ListeningPolicy observations; raw feedback must not add
    // a second, non-undoable preference penalty or reward.
    const legacyFeedback = policyMode === "adaptive" ? [] : (input.feedback ?? []);
    const familiarityByRecording = aggregateRecordingFamiliarity(
      allNormalizedStats,
      legacyFeedback,
      recordingReferences
    );
    const lockedRecordings = new Set([...lockedTrackKeys].flatMap((trackKey) => {
      const recordingKey = resolveRecordingReference(trackKey, recordingReferences);
      return recordingKey ? [recordingKey] : [];
    }));
    const feedbackMultiplierByRecording = new Map([...familiarityByRecording.keys()].map((recordingKey) => [
      recordingKey,
      recordingFeedbackMultiplier(recordingKey, legacyFeedback, recordingReferences)
    ]));
    const normalizedStats = allNormalizedStats
      .filter((stat) => isEligibleRecommendationTrack(stat.track))
      .filter((stat) => !blockedRecordingKeys.has(stat.track.recordingKey!))
      .filter((stat) => (feedbackMultiplierByRecording.get(stat.track.recordingKey!) ?? 1) > 0);
    const topRecordingKeys = new Set(input.profile.topTracks.flatMap((item) => {
      const recordingKey = resolveRecordingReference(item.id, recordingReferences);
      return recordingKey ? [recordingKey] : [];
    }));
    const candidates: PlanCandidate[] = normalizedStats.map((stat) => {
      const recordingKey = stat.track.recordingKey!;
      const familiarity = familiarityByRecording.get(recordingKey)!;
      const effectiveStat: TrackStat = {
        ...stat,
        playCount: familiarity.playCount,
        ...(familiarity.likedAt ? { likedAt: familiarity.likedAt } : {}),
        ...(familiarity.localFavoritedAt ? { localFavoritedAt: familiarity.localFavoritedAt } : {})
      };
      const explore = familiarity.playCount === 0 &&
        !familiarity.likedAt &&
        !familiarity.localFavoritedAt &&
        !familiarity.lastPlayedAt &&
        !familiarity.positiveFeedback;
      return {
        stat: effectiveStat,
        recordingKey,
        explore,
        soft: isSoftTrack(stat.track),
        classical: isClassicalTrack(stat.track),
        longTerm: recordingIsLongTerm(familiarity),
        memoryScore: recordingMemoryScore(familiarity, topRecordingKeys, recordingKey)
      };
    });
    const legacyCandidates = candidates.filter((candidate) => libraryTrackKeys.has(getTrackKey(candidate.stat.track)))
      .filter((candidate) => satisfiesListeningConstraints(candidate.stat.track, input.sessionIntent?.constraints));
    const candidateByRecording = new Map<string, PlanCandidate>();
    for (const candidate of candidates) {
      const current = candidateByRecording.get(candidate.recordingKey);
      if (!current || candidate.memoryScore > current.memoryScore) {
        candidateByRecording.set(candidate.recordingKey, candidate);
      }
    }
    const contexts = new Map(PERIODS.map((period) => {
      const weather = input.weatherByPeriod?.[period.period] ?? input.weather;
      const routine = input.routine.filter((block) => overlaps(block, period.start, period.end));
      return [period.period, {
        weather,
        routine,
        availableDurationMs: availableDuration(period.start, period.end, routine)
      }] as const;
    }));
    const rankedCache = new Map<PlanPeriod, RankedCandidate[]>();
    let policyFallbackOccurred = false;
    const rankedFor = (period: PlanPeriod): RankedCandidate[] => {
      const cached = rankedCache.get(period);
      if (cached) return cached;
      const context = contexts.get(period)!;
      let effectivePolicyMode = policyMode;
      let decisions = [] as ReturnType<ListeningPolicy["rank"]>;
      if (policyMode !== "legacy") {
        try {
          decisions = this.listeningPolicy.rank({
            stats: policyStats,
            ...(policyCandidates.length > 0 ? { candidates: policyCandidates } : {}),
            profile: input.profile,
            rules: input.rules,
            ...(input.feedback ? { events: input.feedback } : {}),
            context: {
              constraints: input.sessionIntent?.constraints ?? [],
              period,
              weather: context.weather.weather,
              routine: context.routine,
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...((input.sessionIntent?.direction !== "avoid" && input.sessionIntent?.value) || input.desiredMood
                ? { desiredMood: input.sessionIntent?.direction !== "avoid" ? input.sessionIntent?.value ?? input.desiredMood : input.desiredMood }
                : {})
            }
          });
        } catch (error) {
          effectivePolicyMode = "legacy";
          policyFallbackOccurred = true;
          input.onPolicyError?.(error);
        }
      }
      if (policyMode === "shadow") {
        input.onShadowRanking?.(period, decisions);
      }
      const policyRanked = decisions
        .flatMap((decision): RankedCandidate[] => {
          const stat = allNormalizedStats.find((entry) => getTrackKey(entry.track) === getTrackKey(decision.track));
          const familiarity = familiarityByRecording.get(decision.recordingKey);
          if (!stat || !familiarity) return [];
          const effectiveStat: TrackStat = {
            ...stat,
            playCount: familiarity.playCount,
            ...(familiarity.likedAt ? { likedAt: familiarity.likedAt } : {}),
            ...(familiarity.localFavoritedAt ? { localFavoritedAt: familiarity.localFavoritedAt } : {})
          };
          const candidate: PlanCandidate = {
            stat: effectiveStat,
            recordingKey: decision.recordingKey,
            explore: familiarity.playCount === 0 &&
              !familiarity.likedAt &&
              !familiarity.localFavoritedAt &&
              !familiarity.lastPlayedAt &&
              !familiarity.positiveFeedback,
            soft: isSoftTrack(decision.track),
            classical: isClassicalTrack(decision.track),
            longTerm: recordingIsLongTerm(familiarity),
            memoryScore: recordingMemoryScore(familiarity, topRecordingKeys, decision.recordingKey),
            decisionId: decision.decisionId,
            evidence: decision.evidence,
            policyVersion: decision.policyVersion,
            recommendationSource: decision.source
          };
          return [{
            ...candidate,
            score: decision.score + periodThemeBonus(candidate, period),
            tie: hash(`${input.date}|${period}|${getTrackKey(candidate.stat.track)}`)
          }];
        })
        .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));
      if (effectivePolicyMode === "adaptive") {
        rankedCache.set(period, policyRanked);
        return policyRanked;
      }
      const legacyRanked = legacyCandidates
        .map((candidate): RankedCandidate => {
          return {
            ...candidate,
            score: scoreTrack(
              candidate.stat,
              input.profile,
              input.rules,
              period,
              context.weather.weather,
              context.routine
            ) * (feedbackMultiplierByRecording.get(candidate.recordingKey) ?? 1) +
              periodThemeBonus(candidate, period),
            tie: hash(`${input.date}|${period}|${getTrackKey(candidate.stat.track)}`)
          };
        })
        .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));
      rankedCache.set(period, legacyRanked);
      return legacyRanked;
    };
    const afternoonRanked = rankedFor("afternoon");
    const afternoonClassical = reserveRecordingKeys(
      afternoonRanked,
      (candidate) => candidate.classical,
      quotas.afternoonClassical
    );
    const eveningRanked = [...rankedFor("evening")]
      .sort((left, right) => right.memoryScore - left.memoryScore || right.score - left.score || left.tie.localeCompare(right.tie));
    const eveningMemory = reserveRecordingKeys(
      eveningRanked,
      (candidate) => candidate.longTerm,
      quotas.eveningMemory,
      afternoonClassical
    );
    const afternoonReserved = reserveRecordingKeys(
      afternoonRanked,
      (candidate) => candidate.soft,
      quotas.afternoonSoft,
      eveningMemory,
      afternoonClassical
    );
    const morningExplore = reserveRecordingKeys(
      rankedFor("morning"),
      (candidate) => candidate.explore,
      quotas.morningExplore,
      mergeSets(afternoonReserved, eveningMemory)
    );
    if (policyMode === "adaptive" && policyFallbackOccurred) {
      const {
        onPolicyError: _onPolicyError,
        onShadowRanking: _onShadowRanking,
        ...fallbackInput
      } = input;
      const fallback = this.generate({ ...fallbackInput, policyMode: "legacy" });
      return {
        ...fallback,
        contextHash: hash(JSON.stringify({
          plannerVersion: DAILY_PLAN_VERSION,
          requestedPolicyMode: "adaptive",
          effectivePolicyMode: "legacy",
          policyFallback: true,
          legacyContextHash: fallback.contextHash
        }))
      };
    }
    const segments: DailyPlanSegment[] = [];

    for (const period of PERIODS) {
      const context = contexts.get(period.period)!;
      const segmentWeather = context.weather;
      const routine = context.routine;
      const items: RadioPlanItem[] = [];
      const selectedCandidates: PlanCandidate[] = [];
      const selectedBySource = new Map<string, number>();
      const scored = period.period === "evening" ? eveningRanked : rankedFor(period.period);
      const candidateSources = [...new Set(scored.map(({ stat }) => stat.track.source!))].sort();

      const addRanked = (selected: RankedCandidate, theme: string): boolean => {
        if (
          items.length >= MAX_TRACKS_PER_PERIOD ||
          usedRecordings.has(selected.recordingKey) ||
          lockedRecordings.has(selected.recordingKey)
        ) return false;
        if (!respectsArtistGap(selected.stat.track, recentArtists)) return false;
        const { stat, score } = selected;
        usedRecordings.add(selected.recordingKey);
        selectedBySource.set(stat.track.source!, (selectedBySource.get(stat.track.source!) ?? 0) + 1);
        rememberArtists(recentArtists, stat.track);
        const context = [weatherLabel(segmentWeather.weather), ...routine.map((block) => block.activity)]
          .filter(Boolean).join(" + ");
        items.push({
          track: stat.track,
          score: Number(score.toFixed(4)),
          reason: `${theme}${context ? ` · ${context}` : ""}`,
          bucket: selected.explore ? "explore" : "familiar",
          source: selected.recommendationSource ??
            recommendationSourceByTrackKey.get(getTrackKey(stat.track)) ?? "library",
          ...(selected.decisionId ? { decisionId: selected.decisionId } : {}),
          ...(selected.evidence ? { evidence: selected.evidence } : {}),
          ...(selected.policyVersion ? { policyVersion: selected.policyVersion } : {})
        });
        selectedCandidates.push(selected);
        return true;
      };
      const countSelected = (predicate: (candidate: PlanCandidate) => boolean): number =>
        selectedCandidates.filter(predicate).length;
      const selectUntil = (
        pool: RankedCandidate[],
        eligibility: (candidate: PlanCandidate) => boolean,
        quota: (candidate: PlanCandidate) => boolean,
        target: number,
        theme: string,
        blocked = new Set<string>()
      ): void => {
        for (const candidate of pool) {
          if (countSelected(quota) >= target || items.length >= MAX_TRACKS_PER_PERIOD) break;
          if (blocked.has(candidate.recordingKey) || !eligibility(candidate)) continue;
          addRanked(candidate, themeForCandidate(theme, candidate));
        }
      };
      const selectOne = (
        pool: RankedCandidate[],
        eligibility: (candidate: PlanCandidate) => boolean,
        theme: string,
        blocked = new Set<string>()
      ): boolean => {
        const available = pool.filter((candidate) =>
          !usedRecordings.has(candidate.recordingKey) &&
          !lockedRecordings.has(candidate.recordingKey) &&
          !blocked.has(candidate.recordingKey) &&
          eligibility(candidate) &&
          respectsArtistGap(candidate.stat.track, recentArtists)
        );
        const underfilledSource = candidateSources.find((source) =>
          (selectedBySource.get(source) ?? 0) < 1 &&
          available.some(({ stat }) => stat.track.source === source)
        );
        const selected = available.find(({ stat }) => !underfilledSource || stat.track.source === underfilledSource) ?? available[0];
        return selected ? addRanked(selected, themeForCandidate(theme, selected)) : false;
      };

      if (context.availableDurationMs > 0) {
        const previousIsCompatible = previousIsSameDay && isCompatiblePreviousPlan(input.previous);
        const previousItems = previousIsCompatible
          ? input.previous?.segments.find((segment) => segment.period === period.period)?.items ?? []
          : [];
        for (const item of previousItems) {
          if (items.length >= MAX_TRACKS_PER_PERIOD) break;
          const trackKey = getTrackKey(item.track);
          if (!lockedTrackKeys.has(trackKey)) continue;
          const recordingKey = normalizeTrackIdentity(item.track).recordingKey!;
          if (usedRecordings.has(recordingKey)) continue;
          const candidate = candidateByRecording.get(recordingKey);
          items.push(candidate
            ? { ...item, bucket: candidate.explore ? "explore" : "familiar" }
            : item);
          usedRecordings.add(recordingKey);
          rememberArtists(recentArtists, item.track);
          const source = normalizeTrackIdentity(item.track).source!;
          selectedBySource.set(source, (selectedBySource.get(source) ?? 0) + 1);
          if (candidate) selectedCandidates.push(candidate);
        }

        const futureReservations = period.period === "morning"
          ? mergeSets(afternoonReserved, eveningMemory)
          : period.period === "afternoon"
            ? eveningMemory
            : new Set<string>();

        if (period.period === "morning") {
          const explorePositions = new Set([0, 3, 6, 9]);
          while (items.length < MAX_TRACKS_PER_PERIOD) {
            const exploreCount = countSelected((candidate) => candidate.explore);
            const exploreNeeded = Math.max(0, quotas.morningExplore - exploreCount);
            const remainingSlots = MAX_TRACKS_PER_PERIOD - items.length;
            const remainingExplorePositions = [...explorePositions]
              .filter((position) => position >= items.length).length;
            const wantsExplore = exploreNeeded > 0 && (
              explorePositions.has(items.length) ||
              remainingSlots <= exploreNeeded ||
              remainingExplorePositions < exploreNeeded
            );
            let added = false;
            if (wantsExplore) {
              added = selectOne(
                scored,
                (candidate) => morningExplore.has(candidate.recordingKey) && candidate.explore,
                "晨间探索"
              ) || selectOne(
                scored,
                (candidate) => candidate.explore,
                "晨间探索",
                futureReservations
              );
            }
            if (!added) {
              added = selectOne(scored, (candidate) => !candidate.explore, "晨间口味", futureReservations);
            }
            if (!added && exploreNeeded > 0) {
              added = selectOne(scored, (candidate) => candidate.explore, "晨间探索", futureReservations);
            }
            if (!added) {
              added = selectOne(scored, (candidate) => !candidate.explore, "晨间口味");
            }
            if (!added) {
              added = selectOne(scored, (candidate) => candidate.explore, "晨间探索", futureReservations) ||
                selectOne(scored, (candidate) => candidate.explore, "晨间探索");
            }
            if (!added) break;
          }
        } else if (period.period === "afternoon") {
          selectUntil(
            scored,
            (candidate) => afternoonClassical.has(candidate.recordingKey) && candidate.classical,
            (candidate) => candidate.classical,
            quotas.afternoonClassical,
            "午后柔和"
          );
          selectUntil(
            scored,
            (candidate) => candidate.classical,
            (candidate) => candidate.classical,
            quotas.afternoonClassical,
            "午后柔和",
            eveningMemory
          );
          selectUntil(
            scored,
            (candidate) => afternoonReserved.has(candidate.recordingKey) && candidate.soft,
            (candidate) => candidate.soft,
            quotas.afternoonSoft,
            "午后柔和"
          );
          selectUntil(
            scored,
            (candidate) => candidate.soft,
            (candidate) => candidate.soft,
            quotas.afternoonSoft,
            "午后柔和",
            eveningMemory
          );
        } else {
          selectUntil(
            scored,
            (candidate) => eveningMemory.has(candidate.recordingKey) && candidate.longTerm,
            (candidate) => candidate.longTerm,
            quotas.eveningMemory,
            "晚间回忆"
          );
          selectUntil(
            scored,
            (candidate) => candidate.longTerm,
            (candidate) => candidate.longTerm,
            quotas.eveningMemory,
            "晚间回忆"
          );
        }

        while (items.length < MAX_TRACKS_PER_PERIOD) {
          const available = scored.filter((candidate) =>
            !usedRecordings.has(candidate.recordingKey) &&
            !lockedRecordings.has(candidate.recordingKey) &&
            !futureReservations.has(candidate.recordingKey) &&
            respectsArtistGap(candidate.stat.track, recentArtists)
          );
          const fallback = available.length > 0 ? available : scored.filter((candidate) =>
            !usedRecordings.has(candidate.recordingKey) &&
            !lockedRecordings.has(candidate.recordingKey) &&
            respectsArtistGap(candidate.stat.track, recentArtists)
          );
          const underfilledSource = candidateSources.find((source) =>
            (selectedBySource.get(source) ?? 0) < 1 && fallback.some(({ stat }) => stat.track.source === source)
          );
          const selected = fallback.find(({ stat }) => !underfilledSource || stat.track.source === underfilledSource) ?? fallback[0];
          if (!selected || !addRanked(selected, defaultTheme(period.period, selected))) break;
        }
      }
      const duration = items.reduce((total, item) => total + trackDuration(item.track), 0);
      segments.push({
        period: period.period,
        start: localDateTime(input.date, period.start, input.timezone),
        end: localDateTime(input.date, period.end, input.timezone),
        targetDurationMs: duration,
        weather: segmentWeather.weather,
        ...(segmentWeather.temperature !== undefined ? { temperature: segmentWeather.temperature } : {}),
        routine,
        items
      });
    }

    return {
      date: input.date,
      timezone: input.timezone,
      revision: (input.previous?.revision ?? 0) + 1,
      generatedAt,
      contextHash,
      consumedTrackKeys: [...consumed],
      segments
    };
  }
}

export function rollingWindow(plan: DailyPlan, at = new Date(), limit = 10): RadioPlanItem[] {
  const timestamp = at.getTime();
  const segmentIndex = Math.max(0, plan.segments.findIndex((segment) => timestamp < Date.parse(segment.end)));
  const consumed = new Set(plan.consumedTrackKeys);
  const future = plan.segments.slice(segmentIndex);
  const past = plan.segments.slice(0, segmentIndex);
  return [...future, ...past]
    .flatMap((segment) => segment.items)
    .filter((item) => !consumed.has(getTrackKey(item.track)))
    .slice(0, limit);
}

export function playbackSegment(plan: DailyPlan, at = new Date()): DailyPlanSegment | undefined {
  const timestamp = at.getTime();
  return plan.segments.find((segment) => {
    const start = Date.parse(segment.start);
    const end = Date.parse(segment.end);
    return timestamp >= start && timestamp < end;
  }) ?? plan.segments.find((segment) => timestamp < Date.parse(segment.end)) ?? plan.segments.at(-1);
}

function isCompatiblePreviousPlan(plan: DailyPlan | undefined): boolean {
  return Boolean(
    plan &&
    plan.segments.length === PERIODS.length &&
    PERIODS.every((period, index) =>
      plan.segments[index]?.period === period.period &&
      (plan.segments[index]?.items.length ?? MAX_TRACKS_PER_PERIOD + 1) <= MAX_TRACKS_PER_PERIOD
    )
  );
}

function aggregateRecordingFamiliarity(
  stats: TrackStat[],
  feedback: PlayEvent[],
  references: RecordingReferenceIndex
): Map<string, RecordingFamiliarity> {
  const output = new Map<string, RecordingFamiliarity>();
  for (const stat of stats) {
    const recordingKey = stat.track.recordingKey!;
    const trackKey = getTrackKey(stat.track);
    const current = output.get(recordingKey) ?? {
      playCount: 0,
      positiveFeedback: false,
      trackKeys: new Set<string>()
    };
    current.playCount += Math.max(0, stat.playCount);
    const likedAt = laterTimestamp(current.likedAt, stat.likedAt);
    const localFavoritedAt = laterTimestamp(current.localFavoritedAt, stat.localFavoritedAt);
    const lastPlayedAt = laterTimestamp(current.lastPlayedAt, stat.lastPlayedAt);
    if (likedAt) current.likedAt = likedAt;
    if (localFavoritedAt) current.localFavoritedAt = localFavoritedAt;
    if (lastPlayedAt) current.lastPlayedAt = lastPlayedAt;
    current.trackKeys.add(trackKey);
    output.set(recordingKey, current);
  }
  for (const event of feedback) {
    if (!["play", "like", "complete", "replay"].includes(event.type)) continue;
    const recordingKey = resolveRecordingReference(event.trackId, references);
    const familiarity = recordingKey ? output.get(recordingKey) : undefined;
    if (familiarity) familiarity.positiveFeedback = true;
  }
  return output;
}

function laterTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function buildRecordingReferenceIndex(stats: TrackStat[]): RecordingReferenceIndex {
  const canonical = new Map<string, string>();
  const rawAliases = new Map<string, Set<string>>();
  for (const stat of stats) {
    const track = stat.track;
    const recordingKey = track.recordingKey!;
    canonical.set(getTrackKey(track), recordingKey);
    for (const alias of [String(track.id), track.sourceId, track.trackKey]) {
      const normalizedAlias = alias?.trim();
      if (!normalizedAlias) continue;
      const recordings = rawAliases.get(normalizedAlias) ?? new Set<string>();
      recordings.add(recordingKey);
      rawAliases.set(normalizedAlias, recordings);
    }
  }
  return { canonical, rawAliases };
}

function resolveRecordingReference(
  value: string | number,
  references: RecordingReferenceIndex
): string | undefined {
  const raw = String(value).trim();
  const canonical = references.canonical.get(raw) ??
    references.canonical.get(normalizeTrackReference(value));
  if (canonical) return canonical;
  const aliases = references.rawAliases.get(raw);
  return aliases?.size === 1 ? [...aliases][0] : undefined;
}

function recordingMemoryScore(
  familiarity: RecordingFamiliarity,
  topRecordingKeys: Set<string>,
  recordingKey: string
): number {
  return Math.log1p(familiarity.playCount) * 1.6 +
    (familiarity.likedAt ? 2 : 0) +
    (familiarity.localFavoritedAt ? 3 : 0) +
    (familiarity.positiveFeedback ? 0.75 : 0) +
    (topRecordingKeys.has(recordingKey) ? 2.5 : 0);
}

function recordingIsLongTerm(familiarity: RecordingFamiliarity): boolean {
  return familiarity.playCount >= 10 ||
    (familiarity.playCount >= 3 && Boolean(familiarity.likedAt || familiarity.localFavoritedAt));
}

function periodThemeBonus(candidate: PlanCandidate, period: PlanPeriod): number {
  if (period === "morning") return candidate.explore ? 0.45 : 0;
  if (period === "afternoon") return candidate.classical ? 0.55 : candidate.soft ? 0.4 : 0;
  return Math.min(0.55, candidate.memoryScore / 18);
}

function reserveRecordingKeys(
  pool: RankedCandidate[],
  predicate: (candidate: PlanCandidate) => boolean,
  target: number,
  blocked = new Set<string>(),
  seed = new Set<string>()
): Set<string> {
  const reserved = new Set(seed);
  for (const candidate of pool) {
    if (reserved.size >= target) break;
    if (blocked.has(candidate.recordingKey) || reserved.has(candidate.recordingKey) || !predicate(candidate)) continue;
    reserved.add(candidate.recordingKey);
  }
  return reserved;
}

function mergeSets(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function isClassicalTrack(track: Track): boolean {
  return themeTags(track).some((tag) =>
    tag.category === "style" && /古典|器乐|classical|instrumental|钢琴|piano/iu.test(tag.value)
  );
}

function isSoftTrack(track: Track): boolean {
  if (isClassicalTrack(track)) return true;
  return themeTags(track).some((tag) => {
    if (tag.category === "mood") return /calm|warm|柔和|平静|舒缓|治愈|温暖/iu.test(tag.value);
    if (tag.category === "scene") return /放松|治愈|安静|relax|healing/iu.test(tag.value);
    if (tag.category === "style") return /acoustic|民谣|轻音乐/iu.test(tag.value);
    return false;
  });
}

function themeTags(track: Track): MusicTag[] {
  const tags = [
    ...inferTrackTags(track),
    ...(track.tagEvidence ?? [])
      .filter((tag) => tag.confidence >= 0.55)
      .map(({ category, value }) => ({ category, value }))
  ];
  return [...new Map(tags.map((tag) => [
    `${tag.category}:${tag.value.trim().toLowerCase()}`,
    tag
  ])).values()];
}

function themeForCandidate(theme: string, candidate: PlanCandidate): string {
  return theme === "午后柔和" && candidate.classical ? `${theme} · 古典/器乐` : theme;
}

function defaultTheme(period: PlanPeriod, candidate: PlanCandidate): string {
  if (period === "morning") return candidate.explore ? "晨间探索" : "晨间口味";
  if (period === "afternoon") return themeForCandidate(candidate.soft ? "午后柔和" : "午后平衡", candidate);
  return candidate.explore ? "晚间新声" : "晚间熟悉";
}

function scoreTrack(
  stat: TrackStat,
  profile: TasteProfile,
  rules: TasteManualRules,
  period: DayPeriod,
  weather: WeatherKind,
  routine: RoutineBlock[]
): number {
  const tags = themeTags(stat.track);
  const tagKeys = new Set(tags.map((tag) => `${tag.category}:${tag.value.toLowerCase()}`));
  const artistTaste = Math.max(0, ...stat.track.artists.map((artist) =>
    profile.topArtists.find((item) => item.name.toLowerCase() === artist.toLowerCase())?.weight ?? 0
  ));
  const tagTaste = profile.preferenceTags.reduce(
    (total, tag) => total + (tagKeys.has(`${tag.category}:${tag.value.toLowerCase()}`) ? tag.weight : 0),
    0
  );
  const taste = clamp(artistTaste + tagTaste);
  const contextTags: MusicTag[] = [
    { category: "period", value: periodLabel(period) },
    { category: "weather", value: weatherLabel(weather) },
    ...routine.flatMap((block) => block.tags)
  ];
  const context = contextTags.length === 0 ? 0.5 : clamp(
    contextTags.filter((tag) => tagKeys.has(`${tag.category}:${tag.value.toLowerCase()}`)).length /
    Math.max(1, contextTags.length) + weatherMoodAffinity(stat.track, weather)
  );
  const familiar = clamp(
    Math.log1p(stat.playCount) / 5 +
    (stat.likedAt ? 0.35 : 0) +
    (stat.localFavoritedAt ? 0.4 : 0)
  );
  const source = stat.track.source === "qq" || stat.track.source === "ncm" ? 1 : 0.5;
  const diversity = 1 - familiar * 0.35;
  const manual = manualMultiplier(stat.track, tags, rules);
  return (taste * 0.3 + context * 0.3 + familiar * 0.2 + source * 0.1 + diversity * 0.1) * manual;
}

function manualMultiplier(track: Track, tags: MusicTag[], rules: TasteManualRules): number {
  let multiplier = 1;
  for (const artist of track.artists) multiplier *= rules.artistWeights[artist] ?? 1;
  for (const tag of tags) multiplier *= rules.tagWeights[`${tag.category}:${tag.value}`] ?? rules.tagWeights[tag.value] ?? 1;
  return multiplier;
}

function recordingFeedbackMultiplier(
  recordingKey: string,
  events: PlayEvent[],
  references: RecordingReferenceIndex
): number {
  const now = Date.now();
  const relevant = events
    .filter((event) => resolveRecordingReference(event.trackId, references) === recordingKey)
    .filter((event) => {
      const at = Date.parse(event.at);
      return Number.isFinite(at) && now - at <= 90 * 24 * 60 * 60 * 1000;
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const lastPositive = relevant.find((event) => ["play", "like", "complete", "replay"].includes(event.type));
  const positiveAt = lastPositive ? Date.parse(lastPositive.at) : Number.NEGATIVE_INFINITY;
  const skips = relevant.filter((event) => event.type === "skip" && Date.parse(event.at) > positiveAt);
  if (skips.length >= 2) return 0;
  if (skips.length === 1 && now - Date.parse(skips[0]!.at) <= 30 * 24 * 60 * 60 * 1000) return 0.15;
  return 1;
}

function isBlocked(track: Track, rules: TasteManualRules): boolean {
  const blockedArtists = new Set(rules.blockedArtists.map((item) => item.toLowerCase()));
  if (track.artists.some((artist) => blockedArtists.has(artist.toLowerCase()))) return true;
  const blockedTags = new Set(rules.blockedTags.map((item) => item.toLowerCase()));
  return themeTags(track).some((tag) =>
    blockedTags.has(tag.value.toLowerCase()) || blockedTags.has(`${tag.category}:${tag.value}`.toLowerCase())
  );
}

function respectsArtistGap(track: Track, recentArtists: string[]): boolean {
  const recent = new Set(recentArtists.slice(-4));
  return !track.artists.some((artist) => recent.has(artist.toLowerCase()));
}

function rememberArtists(recentArtists: string[], track: Track): void {
  recentArtists.push(...track.artists.map((artist) => artist.toLowerCase()));
  if (recentArtists.length > 12) recentArtists.splice(0, recentArtists.length - 12);
}

function availableDuration(start: string, end: string, routine: RoutineBlock[]): number {
  const startMin = minutes(start);
  const endMin = end === "24:00" ? 24 * 60 : minutes(end);
  const blockedIntervals = routine
    .filter((block) => !block.musicAllowed)
    .map((block) => {
      const blockStart = minutes(block.start);
      const rawEnd = minutes(block.end);
      const blockEnd = rawEnd <= blockStart ? rawEnd + 24 * 60 : rawEnd;
      return [Math.max(startMin, blockStart), Math.min(endMin, blockEnd)] as const;
    })
    .filter(([blockStart, blockEnd]) => blockEnd > blockStart)
    .sort((left, right) => left[0] - right[0]);
  let blocked = 0;
  let cursorStart = -1;
  let cursorEnd = -1;
  for (const [blockStart, blockEnd] of blockedIntervals) {
    if (blockStart > cursorEnd) {
      if (cursorEnd > cursorStart) blocked += cursorEnd - cursorStart;
      cursorStart = blockStart;
      cursorEnd = blockEnd;
    } else {
      cursorEnd = Math.max(cursorEnd, blockEnd);
    }
  }
  if (cursorEnd > cursorStart) blocked += cursorEnd - cursorStart;
  return Math.max(0, (endMin - startMin - blocked) * 60_000);
}

function overlaps(block: RoutineBlock, start: string, end: string): boolean {
  const blockStart = minutes(block.start);
  const rawEnd = minutes(block.end);
  const blockEnd = rawEnd <= blockStart ? rawEnd + 24 * 60 : rawEnd;
  const segmentStart = minutes(start);
  const segmentEnd = end === "24:00" ? 24 * 60 : minutes(end);
  return blockStart < segmentEnd && blockEnd > segmentStart;
}

function localDateTime(date: string, time: string, timezone: string): string {
  const offset = timezone === "Asia/Shanghai" ? "+08:00" : "Z";
  if (time === "24:00") {
    return `${nextDateKey(date)}T00:00:00${offset}`;
  }
  return `${date}T${time}:00${offset}`;
}

function nextDateKey(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function trackDuration(track: Track): number {
  return typeof track.durationMs === "number" && track.durationMs > 30_000
    ? track.durationMs
    : DEFAULT_DURATION_MS;
}

function weatherMoodAffinity(track: Track, weather: WeatherKind): number {
  const mood = track.moodTag ?? themeTags(track).find((tag) => tag.category === "mood")?.value;
  const preferred: Record<WeatherKind, string[]> = {
    clear: ["energy", "warm"], cloudy: ["calm", "focus"], rain: ["calm", "night", "warm"],
    snow: ["calm", "warm"], fog: ["night", "focus"], storm: ["energy", "night"], unknown: []
  };
  return mood && preferred[weather].includes(mood) ? 0.35 : 0;
}

function minutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function periodLabel(period: DayPeriod): string {
  return { morning: "早晨", afternoon: "午后", evening: "傍晚", late_night: "深夜" }[period];
}

function weatherLabel(weather: WeatherKind): string {
  return { clear: "晴", cloudy: "多云", rain: "雨", snow: "雪", fog: "雾", storm: "风暴", unknown: "" }[weather];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
