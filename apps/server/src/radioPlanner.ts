import { currentPeriod, periodFromHour } from "./time.js";

import type {
  DayPeriod,
  EnvironmentContext,
  MoodTag,
  PlayEvent,
  RadioPlanItem,
  TasteProfile,
  TrackStat
} from "@musicgpt/shared";

interface PlanOptions {
  windowSize?: number;
  desiredMood?: string;
  environment?: EnvironmentContext;
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
    const nowPeriod = options.environment?.dayPeriod ?? currentPeriod();
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
      const periodScore = options.environment
        ? period === nowPeriod
          ? 1
          : (periodWeight.get(period) ?? 0.2)
        : (periodWeight.get(period) ?? 0.2);
      const moodScore = options.desiredMood
        ? entry.track.moodTag === options.desiredMood
          ? 1
          : 0.1
        : 0.5;
      const environmentScore = options.environment
        ? weatherMoodScore(options.environment.weather, entry.track.moodTag)
        : 0.5;
      const skipPenalty = recentSkipIds.has(entry.track.id) ? 0.35 : 1;
      const repeatPenalty = recentPlayIds.has(entry.track.id) ? 0.25 : 1;
      const randomJitter = 0.8 + this.random() * 0.4;
      const baseScore = options.environment
        ? playCountScore * 0.25 + periodScore * 0.08 + moodScore * 0.17 + environmentScore * 0.5
        : playCountScore * 0.45 + periodScore * 0.35 + moodScore * 0.2;
      const score = baseScore * skipPenalty * repeatPenalty * randomJitter;
      const reason = options.environment
        ? `${this.weatherLabel(options.environment.weather)} + ${this.periodLabel(nowPeriod)} + 你的历史偏好`
        : `匹配${this.periodLabel(nowPeriod)}时段偏好 + 历史播放热度`;

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

  private weatherLabel(weather: EnvironmentContext["weather"]): string {
    const labels: Record<EnvironmentContext["weather"], string> = {
      clear: "晴天",
      cloudy: "阴天",
      rain: "雨天",
      snow: "雪天",
      fog: "雾天",
      storm: "雷雨",
      unknown: "当前天气"
    };
    return labels[weather];
  }
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
  return 0.18;
}
