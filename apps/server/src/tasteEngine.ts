import { periodFromHour } from "./time.js";
import { inferTrackTags } from "./trackTags.js";

import type {
  MusicTag,
  MoodTag,
  PlayEvent,
  PreferenceTag,
  TasteProfile,
  TopArtist,
  TrackStat
} from "@musicgpt/shared";

const HALF_LIFE_DAYS = 90;

function daysSince(iso?: string): number {
  if (!iso) {
    return 365;
  }
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return 365;
  }
  const diff = Date.now() - timestamp;
  return Math.max(0, diff / (1000 * 60 * 60 * 24));
}

function recency(iso?: string): number {
  return 2 ** (-daysSince(iso) / HALF_LIFE_DAYS);
}

function normalizeWeights<T extends string>(input: Map<T, number>): Array<{ key: T; value: number }> {
  const total = [...input.values()].reduce((acc, item) => acc + item, 0) || 1;
  return [...input.entries()].map(([key, value]) => ({
    key,
    value: Number((value / total).toFixed(4))
  }));
}

export class TasteEngine {
  generate(stats: TrackStat[], recentEvents: PlayEvent[]): TasteProfile {
    const artistWeights = new Map<string, number>();
    const tagWeights = new Map<string, { tag: MusicTag; score: number; evidenceCount: number }>();
    const periodWeights = new Map<"morning" | "afternoon" | "evening" | "late_night", number>([
      ["morning", 0],
      ["afternoon", 0],
      ["evening", 0],
      ["late_night", 0]
    ]);
    const moodWeights = new Map<MoodTag, number>([
      ["calm", 0],
      ["focus", 0],
      ["warm", 0],
      ["night", 0],
      ["energy", 0],
      ["nostalgia", 0],
      ["unknown", 0]
    ]);

    const statByTrackId = new Map(stats.map((stat) => [stat.track.id, stat]));
    const latestFavoriteEvent = new Map<number, PlayEvent>();
    for (const event of recentEvents) {
      if (event.type !== "like" && event.type !== "unlike") {
        continue;
      }
      if (!latestFavoriteEvent.has(event.trackId)) {
        latestFavoriteEvent.set(event.trackId, event);
      }
    }

    for (const stat of stats) {
      const historicalWeight = Math.log1p(Math.max(0, stat.playCount)) * 1.2;
      const importedLikeWeight = stat.likedAt ? recency(stat.likedAt) : 0;
      const favoriteWeight = stat.localFavoritedAt ? 6 * recency(stat.localFavoritedAt) : 0;
      const weight = historicalWeight + importedLikeWeight + favoriteWeight;
      if (weight <= 0) {
        continue;
      }

      for (const artist of stat.track.artists) {
        artistWeights.set(artist, (artistWeights.get(artist) ?? 0) + weight);
      }
      for (const tag of inferTrackTags(stat.track)) {
        addTagWeight(tagWeights, tag, weight, 1);
      }

      const hour =
        typeof stat.lastPlayedHour === "number"
          ? stat.lastPlayedHour
          : new Date(stat.lastPlayedAt ?? Date.now()).getHours();
      const period = periodFromHour(hour);
      periodWeights.set(period, (periodWeights.get(period) ?? 0) + weight);

      const mood = stat.track.moodTag ?? "unknown";
      moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + weight);

      if (stat.localFavoritedAt) {
        const favoriteEvent = latestFavoriteEvent.get(stat.track.id);
        if (favoriteEvent?.type === "like") {
          for (const tag of tagsFromEventMetadata(favoriteEvent)) {
            addTagWeight(tagWeights, tag, 3 * recency(favoriteEvent.at), 1);
          }
        }
      }
    }

    for (const event of recentEvents) {
      const stat = statByTrackId.get(event.trackId);
      const eventWeight =
        event.type === "replay"
          ? 2
          : event.type === "complete"
            ? 1
            : event.type === "skip"
              ? -3
              : 0;
      if (stat && eventWeight !== 0) {
        for (const tag of inferTrackTags(stat.track)) {
          addTagWeight(tagWeights, tag, eventWeight * recency(event.at), 1);
        }
      }
      if (event.type === "skip") {
        const hour = new Date(event.at).getHours();
        const period = periodFromHour(hour);
        periodWeights.set(period, Math.max(0, (periodWeights.get(period) ?? 0) - 0.3));
      }
    }

    const topArtists: TopArtist[] = normalizeWeights(artistWeights)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((item) => ({ name: item.key, weight: item.value }));

    const favoritePeriods = normalizeWeights(periodWeights)
      .sort((a, b) => b.value - a.value)
      .map((item) => ({ period: item.key, weight: item.value }));

    const moodWeightRecord = Object.fromEntries(
      normalizeWeights(moodWeights).map((item) => [item.key, item.value])
    ) as Record<MoodTag, number>;

    const positiveTags = [...tagWeights.values()].filter((item) => item.score > 0);
    const tagTotal = positiveTags.reduce((total, item) => total + item.score, 0) || 1;
    const preferenceTags: PreferenceTag[] = positiveTags
      .sort((left, right) => right.score - left.score)
      .slice(0, 20)
      .map((item) => ({
        ...item.tag,
        weight: Number((item.score / tagTotal).toFixed(4)),
        evidenceCount: item.evidenceCount
      }));

    const topTracks = [...stats]
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 12)
      .map((item) => ({
        id: item.track.id,
        title: item.track.title,
        playCount: item.playCount
      }));

    const skipRate =
      recentEvents.length === 0
        ? 0
        : recentEvents.filter((event) => event.type === "skip").length / recentEvents.length;

    const pacingPreference: TasteProfile["pacingPreference"] =
      skipRate < 0.15 ? "gentle" : skipRate < 0.3 ? "balanced" : "dynamic";

    const firstPeriod = favoritePeriods[0]?.period ?? "evening";
    const firstArtist = topArtists[0]?.name ?? "你常听的艺人";
    const firstStyle = preferenceTags.find((tag) => tag.category === "style")?.value;
    const summary = `你在${firstPeriod}更活跃，最近偏爱${firstArtist}${firstStyle ? `和${firstStyle}` : ""}这类声音。`;

    return {
      generatedAt: new Date().toISOString(),
      summary,
      topArtists,
      topTracks,
      favoritePeriods,
      moodWeights: moodWeightRecord,
      preferenceTags,
      pacingPreference
    };
  }
}

function addTagWeight(
  weights: Map<string, { tag: MusicTag; score: number; evidenceCount: number }>,
  tag: MusicTag,
  score: number,
  evidenceCount: number
): void {
  const key = `${tag.category}:${tag.value.toLowerCase()}`;
  const current = weights.get(key);
  weights.set(key, {
    tag,
    score: (current?.score ?? 0) + score,
    evidenceCount: (current?.evidenceCount ?? 0) + evidenceCount
  });
}

function tagsFromEventMetadata(event: PlayEvent): MusicTag[] {
  const tags: MusicTag[] = [];
  const period = event.metadata?.period;
  const weather = event.metadata?.weather;
  const contextTags = event.metadata?.contextTags;
  if (typeof period === "string") {
    tags.push({ category: "period", value: period });
  }
  if (typeof weather === "string" && weather !== "未知天气") {
    tags.push({ category: "weather", value: weather });
  }
  if (typeof contextTags === "string") {
    for (const value of contextTags.split("|").map((item) => item.trim()).filter(Boolean)) {
      tags.push({ category: "scene", value });
    }
  }
  return tags;
}
