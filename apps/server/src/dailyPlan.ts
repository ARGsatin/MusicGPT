import { createHash } from "node:crypto";

import type {
  DailyPlan,
  DailyPlanSegment,
  DayPeriod,
  EnvironmentContext,
  MusicTag,
  PlayEvent,
  RadioPlanItem,
  RoutineBlock,
  TasteManualRules,
  TasteProfile,
  Track,
  TrackStat,
  WeatherKind
} from "@musicgpt/shared";

import { getTrackKey, normalizeTrackIdentity } from "./musicCatalog.js";
import { isEligibleRecommendationTrack } from "./recommendationQuality.js";
import { inferTrackTags } from "./trackTags.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = 3.5 * 60 * 1000;
const PERIODS: Array<{ period: DayPeriod; start: string; end: string }> = [
  { period: "morning", start: "07:00", end: "09:00" },
  { period: "afternoon", start: "13:00", end: "15:00" },
  { period: "evening", start: "18:00", end: "20:00" },
  { period: "late_night", start: "22:00", end: "24:00" }
];

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
}

export class DailyPlanEngine {
  generate(input: DailyPlanGenerateInput): DailyPlan {
    const generatedAt = new Date().toISOString();
    const contextHash = hash(JSON.stringify({
      date: input.date,
      timezone: input.timezone,
      weather: input.weather,
      weatherByPeriod: input.weatherByPeriod,
      routine: input.routine,
      rules: input.rules,
      library: input.stats.map((stat) => `${getTrackKey(stat.track)}:${stat.playCount}`),
      feedback: (input.feedback ?? []).slice(0, 200).map((event) => `${event.trackId}:${event.type}:${event.at}`)
    }));
    const consumed = new Set(input.consumedTrackKeys ?? input.previous?.consumedTrackKeys ?? []);
    const locked = new Set(consumed);
    if (input.currentTrackKey) locked.add(input.currentTrackKey);
    const usedRecordings = new Set<string>();
    const recentArtists: string[] = [];
    const candidates = input.stats
      .map((stat) => ({ ...stat, track: normalizeTrackIdentity(stat.track) }))
      .filter((stat) => isEligibleRecommendationTrack(stat.track))
      .filter((stat) => !isBlocked(stat.track, input.rules))
      .filter((stat) => feedbackMultiplier(getTrackKey(stat.track), input.feedback ?? []) > 0);
    const segments: DailyPlanSegment[] = [];

    for (const period of PERIODS) {
      const segmentWeather = input.weatherByPeriod?.[period.period] ?? input.weather;
      const routine = input.routine.filter((block) => overlaps(block, period.start, period.end));
      const targetDurationMs = availableDuration(period.start, period.end, routine);
      const items: RadioPlanItem[] = [];
      const previousItems = input.previous?.segments
        .find((segment) => segment.period === period.period)?.items ?? [];
      for (const item of previousItems) {
        const trackKey = getTrackKey(item.track);
        if (!locked.has(trackKey)) continue;
        const recordingKey = normalizeTrackIdentity(item.track).recordingKey!;
        if (usedRecordings.has(recordingKey)) continue;
        items.push(item);
        usedRecordings.add(recordingKey);
        rememberArtists(recentArtists, item.track);
      }

      let duration = items.reduce((total, item) => total + trackDuration(item.track), 0);
      const scored = candidates
        .filter((stat) => !usedRecordings.has(stat.track.recordingKey!))
        .map((stat) => ({
          stat,
          score: scoreTrack(stat, input.profile, input.rules, period.period, segmentWeather.weather, routine) *
            feedbackMultiplier(getTrackKey(stat.track), input.feedback ?? []),
          tie: hash(`${input.date}|${period.period}|${getTrackKey(stat.track)}`)
        }))
        .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie));
      const selectedBySource = new Map<string, number>();
      for (const item of items) {
        const source = normalizeTrackIdentity(item.track).source!;
        selectedBySource.set(source, (selectedBySource.get(source) ?? 0) + 1);
      }
      const candidateSources = [...new Set(scored.map(({ stat }) => stat.track.source!))].sort();
      while (duration < targetDurationMs) {
        const underfilledSource = candidateSources.find((source) =>
          (selectedBySource.get(source) ?? 0) < 1 && scored.some(({ stat }) =>
            stat.track.source === source &&
            !usedRecordings.has(stat.track.recordingKey!) &&
            respectsArtistGap(stat.track, recentArtists)
          )
        );
        const index = scored.findIndex(({ stat }) =>
          (!underfilledSource || stat.track.source === underfilledSource) &&
          !usedRecordings.has(stat.track.recordingKey!) &&
          respectsArtistGap(stat.track, recentArtists)
        );
        if (index < 0) break;
        const selected = scored.splice(index, 1)[0];
        if (!selected) break;
        const { stat, score } = selected;
        usedRecordings.add(stat.track.recordingKey!);
        selectedBySource.set(stat.track.source!, (selectedBySource.get(stat.track.source!) ?? 0) + 1);
        rememberArtists(recentArtists, stat.track);
        const context = [weatherLabel(segmentWeather.weather), ...routine.map((block) => block.activity)]
          .filter(Boolean).join(" + ");
        items.push({
          track: stat.track,
          score: Number(score.toFixed(4)),
          reason: `${periodLabel(period.period)}${context ? ` · ${context}` : ""} · ${stat.playCount > 0 ? "熟悉偏好" : "探索"}`,
          bucket: stat.playCount > 0 ? "familiar" : "explore",
          source: "library"
        });
        duration += trackDuration(stat.track);
      }
      segments.push({
        period: period.period,
        start: localDateTime(input.date, period.start, input.timezone),
        end: localDateTime(input.date, period.end, input.timezone),
        targetDurationMs,
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

function scoreTrack(
  stat: TrackStat,
  profile: TasteProfile,
  rules: TasteManualRules,
  period: DayPeriod,
  weather: WeatherKind,
  routine: RoutineBlock[]
): number {
  const tags = inferTrackTags(stat.track);
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

function feedbackMultiplier(trackKey: string, events: PlayEvent[]): number {
  const now = Date.now();
  const relevant = events
    .filter((event) => (typeof event.trackId === "number" ? `ncm:${event.trackId}` : event.trackId) === trackKey)
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
  return inferTrackTags(track).some((tag) =>
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
  const blocked = routine.filter((block) => !block.musicAllowed).reduce((total, block) => {
    const blockStart = minutes(block.start);
    const rawEnd = minutes(block.end);
    const blockEnd = rawEnd <= blockStart ? rawEnd + 24 * 60 : rawEnd;
    return total + Math.max(0, Math.min(endMin, blockEnd) - Math.max(startMin, blockStart));
  }, 0);
  return Math.max(0, Math.min(TWO_HOURS_MS, (endMin - startMin - blocked) * 60_000));
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
  const normalizedTime = time === "24:00" ? "23:59:59" : `${time}:00`;
  const offset = timezone === "Asia/Shanghai" ? "+08:00" : "Z";
  return `${date}T${normalizedTime}${offset}`;
}

function trackDuration(track: Track): number {
  return typeof track.durationMs === "number" && track.durationMs > 30_000
    ? track.durationMs
    : DEFAULT_DURATION_MS;
}

function weatherMoodAffinity(track: Track, weather: WeatherKind): number {
  const mood = track.moodTag ?? inferTrackTags(track).find((tag) => tag.category === "mood")?.value;
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
