import { describe, expect, it } from "vitest";

import type { TasteProfile } from "@musicgpt/shared";
import { DjBrain, sanitizeDjText } from "../src/djBrain.js";

const profile: TasteProfile = {
  generatedAt: new Date().toISOString(),
  summary: "晚间更喜欢温柔流行",
  topArtists: [{ name: "A", weight: 0.5 }],
  topTracks: [],
  favoritePeriods: [{ period: "evening", weight: 1 }],
  moodWeights: {
    calm: 0.2,
    focus: 0.1,
    warm: 0.3,
    night: 0.2,
    energy: 0.1,
    nostalgia: 0.05,
    unknown: 0.05
  },
  pacingPreference: "gentle"
};

describe("DjBrain", () => {
  it("sanitizes banned words and truncates", () => {
    const raw = `${"低俗".repeat(4)}${"a".repeat(120)}`;
    const sanitized = sanitizeDjText(raw);
    expect(sanitized.includes("低俗")).toBe(false);
    expect(sanitized.length).toBeLessThanOrEqual(90);
  });

  it("generates fallback script when no api key is provided", async () => {
    const brain = new DjBrain();
    const script = await brain.generate({
      profile,
      nowTrack: { id: 1, title: "Song", artists: ["Artist"] },
      upcoming: []
    });
    expect(script.text.length).toBeGreaterThan(0);
    expect(script.trackIds[0]).toBe(1);
  });
});
