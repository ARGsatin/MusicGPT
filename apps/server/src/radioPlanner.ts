import { currentPeriod, periodFromHour } from "./time.js";

import type { DayPeriod, PlayEvent, RadioPlanItem, TasteProfile, TrackStat } from "@musicgpt/shared";

interface PlanOptions {
  windowSize?: number;
  desiredMood?: string;
}

function normalize(value: number, max: number): number {
  if (max <= 0) {
    return 0;
  }
  return value / max;
}

export class RadioPlanner {
  constructor(private readonly random: () => number = Math.random) {}

  plan(
    stats: TrackStat[],
    profile: TasteProfile,
    events: PlayEvent[],
    options: PlanOptions = {}
  ): RadioPlanItem[] {
    const nowPeriod = currentPeriod();
    const windowSize = options.windowSize ?? 10;
    const recentSkipIds = new Set(
      events.filter((event) => event.type === "skip").slice(0, 12).map((event) => event.trackId)
    );
    const recentPlayIds = new Set(events.slice(0, 12).map((event) => event.trackId));
    const maxPlayCount = stats.reduce((max, item) => Math.max(max, item.playCount), 1);
    const periodWeight = this.periodWeightLookup(profile.favoritePeriods);

    const scored = stats.map((entry) => {
      const period =
        typeof entry.lastPlayedHour === "number"
          ? periodFromHour(entry.lastPlayedHour)
          : nowPeriod;
      const playCountScore = normalize(entry.playCount, maxPlayCount);
      const periodScore = periodWeight.get(period) ?? 0.2;
      const moodScore = options.desiredMood
        ? entry.track.moodTag === options.desiredMood
          ? 1
          : 0.1
        : 0.5;
      const skipPenalty = recentSkipIds.has(entry.track.id) ? 0.35 : 1;
      const repeatPenalty = recentPlayIds.has(entry.track.id) ? 0.25 : 1;
      const randomJitter = 0.8 + this.random() * 0.4;
      const score =
        (playCountScore * 0.45 + periodScore * 0.35 + moodScore * 0.2) *
        skipPenalty *
        repeatPenalty *
        randomJitter;
      const reason = `匹配${this.periodLabel(nowPeriod)}时段偏好 + 历史播放热度`;

      return {
        track: entry.track,
        score: Number(score.toFixed(4)),
        reason
      } satisfies RadioPlanItem;
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, windowSize);
  }

  private periodWeightLookup(
    periods: Array<{ period: DayPeriod; weight: number }>
  ): Map<DayPeriod, number> {
    const map = new Map<DayPeriod, number>();
    for (const item of periods) {
      map.set(item.period, item.weight);
    }
    return map;
  }

  private periodLabel(period: DayPeriod): string {
    if (period === "morning") {
      return "早晨";
    }
    if (period === "afternoon") {
      return "午后";
    }
    if (period === "evening") {
      return "傍晚";
    }
    return "深夜";
  }
}
