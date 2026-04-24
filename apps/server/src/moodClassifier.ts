import type { MoodTag, Track } from "@musicgpt/shared";

const keywordMap: Array<{ mood: MoodTag; keywords: string[] }> = [
  { mood: "calm", keywords: ["钢琴", "轻音乐", "ambient", "lofi", "peace"] },
  { mood: "focus", keywords: ["study", "focus", "工作", "学习", "instrumental"] },
  { mood: "warm", keywords: ["民谣", "acoustic", "sunset", "温柔", "治愈"] },
  { mood: "night", keywords: ["夜", "midnight", "晚安", "moon", "dream"] },
  { mood: "energy", keywords: ["摇滚", "rock", "edm", "dance", "beat"] },
  { mood: "nostalgia", keywords: ["old", "经典", "怀旧", "vintage"] }
];

export function inferMood(track: Track): MoodTag {
  const haystack = `${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`.toLowerCase();

  for (const entry of keywordMap) {
    if (entry.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return entry.mood;
    }
  }
  return "unknown";
}
