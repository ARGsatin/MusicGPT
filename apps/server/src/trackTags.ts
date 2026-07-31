import type {
  DayPeriod,
  EnvironmentContext,
  MusicTag,
  MusicTagCategory,
  Track
} from "@musicgpt/shared";

export const DISCOVERY_STYLES = [
  "流行",
  "摇滚",
  "民谣",
  "电子",
  "R&B/灵魂",
  "爵士",
  "说唱",
  "独立",
  "City Pop",
  "古典/器乐",
  "世界音乐",
  "金属"
] as const;

const styleRules: Array<{ value: string; keywords: string[] }> = [
  { value: "流行", keywords: ["pop", "流行"] },
  { value: "摇滚", keywords: ["rock", "摇滚"] },
  { value: "民谣", keywords: ["folk", "民谣", "acoustic"] },
  { value: "电子", keywords: ["electro", "electronic", "edm", "synth", "电子", "techno", "house"] },
  { value: "R&B/灵魂", keywords: ["r&b", "rnb", "soul", "灵魂"] },
  { value: "爵士", keywords: ["jazz", "爵士"] },
  { value: "说唱", keywords: ["hip hop", "hip-hop", "rap", "说唱"] },
  { value: "独立", keywords: ["indie", "独立"] },
  { value: "City Pop", keywords: ["city pop", "城市流行"] },
  { value: "古典/器乐", keywords: ["classical", "古典", "instrumental", "器乐", "piano", "钢琴"] },
  { value: "世界音乐", keywords: ["world music", "世界音乐", "bossa", "拉丁", "afro"] },
  { value: "金属", keywords: ["metal", "金属"] }
];

const sceneRules: Array<{ value: string; keywords: string[] }> = [
  { value: "学习工作", keywords: ["study", "focus", "coding", "work", "学习", "工作", "代码", "专注"] },
  { value: "散步通勤", keywords: ["walk", "drive", "commute", "散步", "通勤", "开车"] },
  { value: "放松治愈", keywords: ["relax", "healing", "calm", "放松", "治愈", "安静"] },
  { value: "运动派对", keywords: ["workout", "party", "dance", "运动", "派对", "蹦迪"] },
  { value: "睡前夜听", keywords: ["sleep", "night", "midnight", "睡前", "深夜", "夜晚"] }
];

export function inferTrackTags(track: Track, hints: MusicTag[] = []): MusicTag[] {
  const text = `${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`.toLowerCase();
  const tags: MusicTag[] = [
    ...track.artists.filter(Boolean).map((artist) => ({ category: "artist" as const, value: artist })),
    ...hints,
    ...(track.tags ?? [])
  ];

  if (track.moodTag && track.moodTag !== "unknown") {
    tags.push({ category: "mood", value: track.moodTag });
  }
  for (const rule of styleRules) {
    if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      tags.push({ category: "style", value: rule.value });
    }
  }
  for (const rule of sceneRules) {
    if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      tags.push({ category: "scene", value: rule.value });
    }
  }
  return dedupeTags(tags);
}

export function tagsFromContextText(text: string): MusicTag[] {
  const normalized = text.toLowerCase();
  const tags: MusicTag[] = [];
  for (const rule of styleRules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      tags.push({ category: "style", value: rule.value });
    }
  }
  for (const rule of sceneRules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      tags.push({ category: "scene", value: rule.value });
    }
  }
  return dedupeTags(tags);
}

export function environmentTags(environment: EnvironmentContext): MusicTag[] {
  const tags: MusicTag[] = [
    { category: "period", value: periodLabel(environment.dayPeriod) }
  ];
  if (environment.weather !== "unknown") {
    tags.push({ category: "weather", value: weatherLabel(environment.weather) });
  }
  return tags;
}

export function periodLabel(period: DayPeriod): string {
  const labels: Record<DayPeriod, string> = {
    morning: "早晨",
    afternoon: "午后",
    evening: "傍晚",
    late_night: "深夜"
  };
  return labels[period];
}

export function weatherLabel(weather: EnvironmentContext["weather"]): string {
  const labels: Record<EnvironmentContext["weather"], string> = {
    clear: "晴天",
    cloudy: "阴天",
    rain: "雨天",
    snow: "雪天",
    fog: "雾天",
    storm: "雷雨",
    unknown: "未知天气"
  };
  return labels[weather];
}

export function primaryStyle(track: Track): string | undefined {
  return inferTrackTags(track).find((tag) => tag.category === "style")?.value;
}

export function dedupeTags(tags: MusicTag[]): MusicTag[] {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const category = normalizeCategory(tag.category);
    const value = tag.value.trim();
    if (!value) {
      return false;
    }
    const key = `${category}:${value.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    tag.category = category;
    tag.value = value;
    return true;
  });
}

function normalizeCategory(category: MusicTagCategory): MusicTagCategory {
  return category;
}
