import { describe, expect, it } from "vitest";

import {
  AI_DJ_PERSONA_STYLE,
  buildChatMessages,
  canFastPathChat,
  OpenAiDjAssistant,
  fallbackChatReply,
  fallbackClassify,
  fallbackComment,
  normalizeIntent
} from "../src/aiDjAssistant.js";

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
      provider: "openai",
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

  it("keeps the assistant lively and gentle while allowing serious conversation", () => {
    const comments = [
      fallbackComment({ id: 11, title: "Soft Steps", artists: ["Mori"], moodTag: "calm" }),
      fallbackComment({ id: 12, title: "Sunny Side", artists: ["Lumi"], moodTag: "energy" }),
      fallbackComment({ id: 13, title: "Warm Hug", artists: ["Nana"], moodTag: "warm" })
    ];
    const chats = [
      fallbackChatReply("陪我聊聊", { messages: [], queue: [] }),
      fallbackChatReply("我想听冷一点", { messages: [], queue: [] })
    ];
    const replies = [...comments, ...chats].join("\n");

    expect(AI_DJ_PERSONA_STYLE).toContain("活泼、温柔");
    expect(AI_DJ_PERSONA_STYLE).toContain("邻家女孩");
    expect(AI_DJ_PERSONA_STYLE).toContain("自己的喜恶和判断");
    expect(AI_DJ_PERSONA_STYLE).toContain("严肃或脆弱");
    expect(replies).toMatch(/[呀啦诶～]/);
    expect(replies).not.toMatch(/深沉|灵魂|夜色|唱针|灰质|骨相/);
  });

  it("builds a real role-ordered conversation without duplicating the current message", () => {
    const messages = buildChatMessages("你觉得换工作值得吗？", {
      messages: [
        { role: "user", text: "我最近有点累", at: "2026-07-30T08:00:00.000Z" },
        { role: "assistant", text: "是工作上的累吗？", at: "2026-07-30T08:00:01.000Z" },
        { role: "user", text: "你觉得换工作值得吗？", at: "2026-07-30T08:00:02.000Z" }
      ],
      memories: [
        {
          id: 1,
          category: "background",
          content: "用户最近在考虑换工作",
          createdAt: "2026-07-30T07:00:00.000Z",
          updatedAt: "2026-07-30T07:00:00.000Z"
        }
      ],
      queue: []
    });

    expect(messages.slice(-3).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user"
    ]);
    expect(
      messages.filter(
        (entry) => entry.role === "user" && entry.content === "你觉得换工作值得吗？"
      )
    ).toHaveLength(1);
    expect(messages[0]?.content).toContain("任何日常话题");
    expect(messages[0]?.content).not.toMatch(/80\s*字|1[–-]3\s*句/);
    expect(messages.some((entry) => String(entry.content).includes("考虑换工作"))).toBe(true);
  });

  it("does not treat explicit no-playback chat as a song request", () => {
    expect(fallbackClassify("别点歌，随便聊聊你怎么看今晚这首歌的气质")).toEqual({ type: "chat" });
    expect(fallbackClassify("只聊天：你现在是真的在线吗？")).toEqual({ type: "chat" });
  });

  it("requires an explicit music operation instead of reacting to music words alone", () => {
    expect(fallbackClassify("我刚播放了一个旅行视频")).toEqual({ type: "chat" });
    expect(fallbackClassify("这个推荐算法挺有意思")).toEqual({ type: "chat" });
    expect(fallbackClassify("我今天感觉很平静")).toEqual({ type: "chat" });
    expect(fallbackClassify("给我推荐一点轻爵士")).toMatchObject({
      type: "play_by_description"
    });
    expect(fallbackClassify("帮我找首周杰伦的歌")).toMatchObject({
      type: "play_by_description"
    });
    expect(normalizeIntent({ type: "play_specific", query: "旅行" }, "我刚播放了一个旅行视频")).toEqual({
      type: "chat"
    });
  });

  it("routes the quick atmosphere request through the dedicated context-aware intent", () => {
    expect(fallbackClassify("来点适合现在氛围的歌")).toEqual({
      type: "play_atmosphere"
    });
    expect(fallbackClassify("根据现在的天气和时间点歌")).toEqual({
      type: "play_atmosphere"
    });
  });

  it("skips the intent-model round trip for unambiguous conversation", () => {
    expect(canFastPathChat("你今天心情怎么样呀？")).toBe(true);
    expect(canFastPathChat("别点歌，只聊天：你觉得这段旋律可爱吗？")).toBe(true);
    expect(canFastPathChat("点一首适合下雨天散步的歌")).toBe(false);
    expect(canFastPathChat("暂停一下")).toBe(false);
    expect(canFastPathChat("calm please")).toBe(false);
  });
});
