import { describe, expect, it } from "vitest";

import { OpenAiDjAssistant, fallbackChatReply, fallbackClassify, fallbackComment } from "../src/aiDjAssistant.js";

describe("AI DJ assistant fallback comments", () => {
  it("uses visibly different fallback reviews for different moods", () => {
    const focus = fallbackComment({ id: 1, title: "Terminal Glow", artists: ["Bit Depth"], moodTag: "focus" });
    const energy = fallbackComment({ id: 2, title: "Rocket Floor", artists: ["Voltage"], moodTag: "energy" });

    expect(focus).not.toBe(energy);
    expect(focus).toContain("Terminal Glow");
    expect(energy).toContain("Rocket Floor");
  });

  it("reports fallback mode when no OpenAI API key is configured", () => {
    const assistant = new OpenAiDjAssistant({ model: "gpt-4.1-mini" });

    expect(assistant.status()).toEqual({
      configured: false,
      model: "gpt-4.1-mini",
      baseUrlConfigured: false
    });
  });

  it("does not use the same canned chat fallback for every message", () => {
    const first = fallbackChatReply("聊聊这首", { messages: [], queue: [] });
    const second = fallbackChatReply("我想听冷一点", { messages: [], queue: [] });

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThan(80);
    expect(second.length).toBeLessThan(80);
  });

  it("does not treat explicit no-playback chat as a song request", () => {
    expect(fallbackClassify("别点歌，随便聊聊你怎么看今晚这首歌的气质")).toEqual({ type: "chat" });
    expect(fallbackClassify("只聊天：你现在是真的在线吗？")).toEqual({ type: "chat" });
  });
});
