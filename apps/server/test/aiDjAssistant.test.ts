import { describe, expect, it } from "vitest";
import type OpenAI from "openai";

import {
  AI_DJ_PERSONA_STYLE,
  buildChatMessages,
  canFastPathChat,
  OpenAiDjAssistant,
  fallbackClassify,
  normalizeIntent,
  summarizeOpenAiError
} from "../src/aiDjAssistant.js";
import { OpenEndedReplyRejectedError } from "../src/openEndedReply.js";

describe("AI DJ assistant", () => {
  it("reports fallback mode when no OpenAI API key is configured", () => {
    const assistant = new OpenAiDjAssistant({ model: "gpt-4.1-mini" });

    expect(assistant.status()).toEqual({
      configured: false,
      provider: "openai",
      model: "gpt-4.1-mini",
      baseUrlConfigured: false
    });
  });

  it("asks for direct, specific language without a forced cute persona", () => {
    expect(AI_DJ_PERSONA_STYLE).toContain("直接、具体、有判断");
    expect(AI_DJ_PERSONA_STYLE).toContain("不知道就明说");
    expect(AI_DJ_PERSONA_STYLE).toContain("自然口语");
    expect(AI_DJ_PERSONA_STYLE).toContain("不要主播腔、客服腔或总结腔");
    expect(AI_DJ_PERSONA_STYLE).not.toContain("邻家女孩");
    expect(AI_DJ_PERSONA_STYLE).not.toContain("活泼、温柔");
  });

  it("rewrites a canned model comment before returning anything to the caller", async () => {
    const drafts = [
      "我喜欢它的分寸感，重点到了，又不会一下子扑得太满。",
      "钢琴的重复音型不断向前推，主旋律拉长时也没有拖慢拍子。"
    ];
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return {
              choices: [{ message: { content: drafts.shift() ?? "" } }]
            };
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({
      model: "test-model",
      client
    });

    const reply = await assistant.commentTrack(
      { id: 1, title: "Flower Dance", artists: ["DJ OKAWARI"] },
      { messages: [], queue: [] },
      "comment_current"
    );

    expect(reply).toBe("钢琴的重复音型不断向前推，主旋律拉长时也没有拖慢拍子。");
    expect(reply).not.toContain("分寸感");
    expect(calls).toBe(2);
  });

  it("stops after two empty responses instead of inventing local prose", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return { choices: [{ message: { content: "" } }] };
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.chat("还在吗", { messages: [], queue: [] })
    ).rejects.toBeInstanceOf(OpenEndedReplyRejectedError);
    expect(calls).toBe(2);
    expect(assistant.status().lastError).toContain("open_ended_reply_rejected:empty");
  });

  it("records a timeout without replacing it with a local persona reply", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            throw new Error("request timed out");
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.chat("还在吗", { messages: [], queue: [] })
    ).rejects.toThrow("request timed out");
    expect(calls).toBe(1);
    expect(assistant.status().lastError).toBe("request timed out");
  });

  it("keeps provider and network details in diagnostics", () => {
    const cause = Object.assign(new Error("socket access was blocked"), { code: "EPERM" });
    const error = Object.assign(new Error("Connection error.", { cause }), {
      status: 503,
      request_id: "request-test"
    });

    expect(summarizeOpenAiError(error)).toContain("status=503");
    expect(summarizeOpenAiError(error)).toContain("request_id=request-test");
    expect(summarizeOpenAiError(error)).toContain("EPERM");
    expect(summarizeOpenAiError(error)).toContain("socket access was blocked");
  });

  it("disables DeepSeek thinking and retries one empty JSON response", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      chat: {
        completions: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            return {
              choices: [
                {
                  message: {
                    content: requests.length === 1 ? "" : '{"type":"pause"}'
                  }
                }
              ]
            };
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({
      model: "deepseek-v4-flash",
      provider: "deepseek",
      client
    });

    await expect(assistant.classify("暂停一下", { messages: [], queue: [] })).resolves.toEqual({
      type: "pause"
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ thinking: { type: "disabled" } });
    expect(assistant.status().lastError).toBeUndefined();
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
