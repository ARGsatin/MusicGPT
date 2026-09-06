import { describe, expect, it } from "vitest";

import { canShowProactiveReminder, EARLY_SKIP_REMINDER, registerEarlySkip } from "./proactiveDj";

describe("moderate proactive DJ policy", () => {
  it("triggers after two early skips in ten minutes", () => {
    const first = registerEarlySkip([], 1_000, 8_000, 200_000);
    const second = registerEarlySkip(first.times, 9 * 60_000, 29_000, 200_000);
    expect(first.trigger).toBe(false);
    expect(second.trigger).toBe(true);
  });

  it("does not count a middle skip as early", () => {
    expect(registerEarlySkip([], 1_000, 80_000, 200_000)).toEqual({ times: [], trigger: false });
  });

  it("uses a twenty minute cooldown except for direct learning receipts", () => {
    const tenMinutesLater = 10 * 60_000;
    expect(canShowProactiveReminder(0, tenMinutesLater, false)).toBe(false);
    expect(canShowProactiveReminder(0, tenMinutesLater, true)).toBe(true);
    expect(canShowProactiveReminder(0, 21 * 60_000, false)).toBe(true);
  });

  it("describes early-skip handling as a reevaluation, not an already-applied penalty", () => {
    expect(EARLY_SKIP_REMINDER).toContain("重新评估");
    expect(EARLY_SKIP_REMINDER).not.toContain("已降低");
    expect(EARLY_SKIP_REMINDER).not.toContain("会降低");
  });
});
