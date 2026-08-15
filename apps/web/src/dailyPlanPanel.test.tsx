import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DailyPlanPanel } from "./components/DailyPlanPanel";

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
});
