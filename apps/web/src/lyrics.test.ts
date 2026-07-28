import { describe, expect, it } from "vitest";

import { findActiveLyricIndex, selectLyricWindow } from "./lyrics";

describe("findActiveLyricIndex", () => {
  it("preserves the first line before playback reaches its timestamp", () => {
    expect(findActiveLyricIndex([{ timeMs: 1_000, text: "first" }], 0)).toBe(0);
  });

  it("finds the latest eligible lyric at the playback boundary", () => {
    const lines = [
      { timeMs: 0, text: "first" },
      { timeMs: 1_000, text: "second" },
      { timeMs: 2_000, text: "third" }
    ];

    expect(findActiveLyricIndex(lines, 880)).toBe(1);
    expect(findActiveLyricIndex(lines, 1_879)).toBe(1);
    expect(findActiveLyricIndex(lines, 1_880)).toBe(2);
  });

  it("uses logarithmic reads for long lyric documents", () => {
    const source = Array.from({ length: 2_048 }, (_, index) => ({
      timeMs: index * 1_000,
      text: `line ${index}`
    }));
    let indexedReads = 0;
    const lines = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexedReads += 1;
        }
        return Reflect.get(target, property, receiver);
      }
    });

    expect(findActiveLyricIndex(lines, 1_500_000)).toBe(1_500);
    expect(indexedReads).toBeLessThanOrEqual(12);
  });

  it("returns -1 when lyrics are unavailable", () => {
    expect(findActiveLyricIndex([], 10_000)).toBe(-1);
  });
});

describe("selectLyricWindow", () => {
  const lines = Array.from({ length: 5 }, (_, index) => ({
    timeMs: index * 1_000,
    text: `line ${index}`
  }));

  it("returns only the previous, current, and next lyric around the active line", () => {
    expect(selectLyricWindow(lines, 2).map(({ index }) => index)).toEqual([1, 2, 3]);
  });

  it("keeps the active line visible at both document boundaries", () => {
    expect(selectLyricWindow(lines, 0).map(({ index }) => index)).toEqual([0, 1]);
    expect(selectLyricWindow(lines, 4).map(({ index }) => index)).toEqual([3, 4]);
  });

  it("never renders more than three rows for a long lyric document", () => {
    const window = selectLyricWindow(lines, 2);

    expect(window).toHaveLength(3);
    expect(window[1]).toMatchObject({ index: 2, line: lines[2] });
  });
});
