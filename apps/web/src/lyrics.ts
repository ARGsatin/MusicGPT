import type { LyricLine } from "@musicgpt/shared";

export function findActiveLyricIndex(
  lines: readonly LyricLine[],
  currentMs: number,
  leadMs = 120
): number {
  if (lines.length === 0) {
    return -1;
  }

  const threshold = currentMs + leadMs;
  let activeIndex = 0;
  let low = 0;
  let high = lines.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle];
    if (line && line.timeMs <= threshold) {
      activeIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return activeIndex;
}
