import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DailyPlan, DayPeriod } from "@musicgpt/shared";

import { DailyPlanPanel, DailyPlanSegments } from "./components/DailyPlanPanel";

describe("DailyPlanPanel", () => {
  it("exposes QQ connection, routine status and the daily-plan surface", () => {
    const html = renderToStaticMarkup(<DailyPlanPanel />);
    expect(html).toContain("双曲源");
    expect(html).toContain("网易云 + QQ 音乐");
    expect(html).toContain("Routine");
    expect(html).toContain("今日音乐计划");
  });

  it("offers one-click playback for the current daily-plan segment", () => {
    const html = renderToStaticMarkup(<DailyPlanPanel />);
    expect(html).toContain("一键播放当前时段");
    expect(html).toContain("aria-label=\"一键播放当前时段歌单\"");
  });

  it("shows three themed ten-track periods with their estimated listening time", () => {
    const periods: Array<{ period: Exclude<DayPeriod, "late_night">; start: string; end: string }> = [
      { period: "morning", start: "2026-08-15T06:00:00+08:00", end: "2026-08-15T12:00:00+08:00" },
      { period: "afternoon", start: "2026-08-15T12:00:00+08:00", end: "2026-08-15T18:00:00+08:00" },
      { period: "evening", start: "2026-08-15T18:00:00+08:00", end: "2026-08-16T00:00:00+08:00" }
    ];
    const plan: DailyPlan = {
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      revision: 1,
      generatedAt: "2026-08-15T00:00:00.000Z",
      contextHash: "test",
      consumedTrackKeys: [],
      segments: periods.map(({ period, start, end }, periodIndex) => ({
        period,
        start,
        end,
        targetDurationMs: 40 * 60 * 1000,
        weather: "clear",
        routine: [],
        items: Array.from({ length: 10 }, (_, index) => ({
          track: {
            id: periodIndex * 10 + index + 1,
            trackKey: `ncm:${periodIndex * 10 + index + 1}`,
            title: `${period} Track ${index + 1}`,
            artists: [`Artist ${index + 1}`],
            durationMs: 240_000
          },
          score: 1,
          reason: "主题推荐",
          source: "library" as const,
          bucket: "familiar" as const
        }))
      }))
    };

    const html = renderToStaticMarkup(<DailyPlanSegments plan={plan} />);
    expect(html).toContain("晨间探索");
    expect(html).toContain("午后柔和");
    expect(html).toContain("晚间回忆");
    expect(html).toContain("06:00–12:00");
    expect(html).toContain("18:00–24:00");
    expect(html).toContain("约 40 分钟 · 10 首");
    expect(html).toContain("evening Track 10");
  });
});
