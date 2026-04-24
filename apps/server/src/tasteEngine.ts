import { periodFromHour } from "./time.js";

import type { MoodTag, PlayEvent, TasteProfile, TopArtist, TrackStat } from "@musicgpt/shared";

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

    for (const stat of stats) {
      const recencyScore = 1 / (1 + daysSince(stat.likedAt));
      const weight = stat.playCount * 1.2 + recencyScore * 8;

      for (const artist of stat.track.artists) {
        artistWeights.set(artist, (artistWeights.get(artist) ?? 0) + weight);
      }

      const hour =
        typeof stat.lastPlayedHour === "number"
          ? stat.lastPlayedHour
          : new Date(stat.lastPlayedAt ?? Date.now()).getHours();
      const period = periodFromHour(hour);
      periodWeights.set(period, (periodWeights.get(period) ?? 0) + weight);

      const mood = stat.track.moodTag ?? "unknown";
      moodWeights.set(mood, (moodWeights.get(mood) ?? 0) + weight);
    }

    for (const event of recentEvents) {
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
    const summary = `你在${firstPeriod}更活跃，最近偏爱${firstArtist}这类声音。`;

    return {
      generatedAt: new Date().toISOString(),
      summary,
      topArtists,
      topTracks,
      favoritePeriods,
      moodWeights: moodWeightRecord,
      pacingPreference
    };
  }
}
