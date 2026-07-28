import type { LyricLine } from "@musicgpt/shared";

export interface VisibleLyricLine {
  index: number;
  line: LyricLine;
}

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

export function selectLyricWindow(
  lines: readonly LyricLine[],
  activeIndex: number
): VisibleLyricLine[] {
  if (lines.length === 0) {
    return [];
  }

  const currentIndex = Math.min(Math.max(activeIndex, 0), lines.length - 1);
  const startIndex = Math.max(0, currentIndex - 1);
  const endIndex = Math.min(lines.length, currentIndex + 2);
  const visibleLines: VisibleLyricLine[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (line) {
      visibleLines.push({ index, line });
    }
  }

  return visibleLines;
}
