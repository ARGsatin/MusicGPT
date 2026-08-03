import { describe, expect, it } from "vitest";
import type OpenAI from "openai";

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
  preferenceTags: [],
  pacingPreference: "gentle"
};

describe("DjBrain", () => {
  it("sanitizes banned words and truncates", () => {
    const raw = `${"低俗".repeat(4)}${"a".repeat(120)}`;
    const sanitized = sanitizeDjText(raw);
    expect(sanitized.includes("低俗")).toBe(false);
    expect(sanitized.length).toBeLessThanOrEqual(90);
  });

  it("skips the scheduled broadcast when no api key is provided", async () => {
    const brain = new DjBrain();
    const script = await brain.generate({
      profile,
      nowTrack: { id: 1, title: "Song", artists: ["Artist"] },
      upcoming: []
    });
    expect(script).toBeUndefined();
  });

  it("rewrites a canned scheduled broadcast before publishing it", async () => {
    const drafts = [
      "这首歌的分寸感很好，重点到了，又不会一下子扑得太满。",
      "当前曲目的短鼓点接到下一首的合成器长音，节拍会从紧凑转为舒展。"
    ];
    let calls = 0;
    const client = {
      responses: {
        create: async () => {
          calls += 1;
          return { output_text: drafts.shift() ?? "" };
        }
      }
    } as unknown as OpenAI;
    const brain = new DjBrain({ model: "test-model", client });

    const script = await brain.generate({
      profile,
      nowTrack: { id: 1, title: "First", artists: ["Artist"] },
      upcoming: [
        {
          track: { id: 2, title: "Second", artists: ["Next"] },
          score: 1,
          reason: "测试"
        }
      ]
    });

    expect(script?.text).toBe("当前曲目的短鼓点接到下一首的合成器长音，节拍会从紧凑转为舒展。");
    expect(script?.text).not.toContain("分寸感");
    expect(calls).toBe(2);
  });
});
