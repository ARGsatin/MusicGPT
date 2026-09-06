import { describe, expect, it } from "vitest";
import type OpenAI from "openai";

import {
  AI_DJ_PERSONA_STYLE,
  buildChatMessages,
  canFastPathChat,
  OpenAiDjAssistant,
  fallbackClassify,
  normalizeActionPlan,
  normalizeIntent,
  summarizeOpenAiError
} from "../src/aiDjAssistant.js";
import { OpenEndedReplyRejectedError } from "../src/openEndedReply.js";

describe("AI DJ assistant", () => {
  it("lets the planner understand a reference even without a shortcut keyword", async () => {
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      actions: [{ action: "play_specific", reference: { kind: "recent", index: 1 } }],
      constraints: [], references: [], confidence: 0.95
    }) } }] }) } } } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test", client });
    expect(await assistant.plan("放刚才那首", { messages: [], queue: [] })).toMatchObject({
      actions: [{ action: "play_specific", reference: { kind: "recent", index: 1 } }]
    });
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

  it("returns one structured action plan for a compound music request", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      chat: {
        completions: {
          create: async (input: Record<string, unknown>) => {
            request = input;
            return ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [
                    { action: "pause", confidence: 1 },
                    {
                      action: "play_by_description",
                      description: "适合工作的歌",
                      searchQuery: "专注 工作",
                      immediate: true,
                      confidence: 0.92
                    }
                  ],
                  constraints: [{ kind: "scene", value: "work", hard: false }],
                  references: [],
                  confidence: 0.92
                })
              }
            }]
            });
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("暂停后换一首适合工作的歌", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [
        { action: "pause" },
        { action: "play_by_description", description: "适合工作的歌", immediate: true }
      ],
      constraints: [{ kind: "scene", value: "work" }],
      references: [],
      confidence: 0.92
    });
    expect(JSON.stringify(request)).toContain("换成/切到/来点");
    expect(JSON.stringify(request)).toContain("immediate=true");
    expect(JSON.stringify(request)).toContain("接下来/后面");
    expect(JSON.stringify(request)).toContain("immediate=false");
  });

  it("recovers an explicit artist request when the model incorrectly returns noop", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{ action: "noop", confidence: 0.95 }],
                  constraints: [],
                  references: [],
                  confidence: 0.95
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("能听一首陈奕迅吗", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{
        action: "play_specific",
        query: "陈奕迅",
        searchQuery: "陈奕迅"
      }],
      confidence: 1
    });
  });

  it("recovers both ordered steps of an explicit pause-then-play request", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{ action: "noop", confidence: 0.96 }],
                  constraints: [],
                  references: [],
                  confidence: 0.96
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("暂停后换一首适合工作的歌", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [
        { action: "pause", confidence: 1 },
        {
          action: "play_by_description",
          description: "适合工作的歌",
          immediate: true,
          confidence: 1
        }
      ],
      confidence: 0.9
    });
  });

  it("preserves query-then-resume order when the model drops the second explicit step", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{ action: "query_queue", confidence: 0.94 }],
                  constraints: [],
                  references: [],
                  confidence: 0.94
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("先告诉我队列，再继续播放", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [
        { action: "query_queue", confidence: 1 },
        { action: "resume", confidence: 1 }
      ],
      confidence: 0.9
    });
  });

  it("does not override a model clarification with the deterministic fallback", () => {
    expect(normalizeActionPlan({
      actions: [{ action: "noop", confidence: 0.9 }],
      constraints: [],
      references: [],
      confidence: 0.9,
      clarification: { question: "你想听陈奕迅的哪一首？" }
    }, "能听一首陈奕迅吗")).toMatchObject({
      actions: [{ action: "noop" }],
      confidence: 0.9,
      clarification: { question: "你想听陈奕迅的哪一首？" }
    });
  });

  it("preserves parsed hard constraints when recovering a deterministic missing action", () => {
    const plan = normalizeActionPlan({ actions: [], constraints: [{ kind: "tag", value: "女声", hard: true }], confidence: 0.9 }, "下一首必须是女声");
    expect(plan.actions[0]?.action).toBe("skip");
    expect(plan.constraints).toEqual([{ kind: "tag", value: "女声", hard: true }]);
  });

  it("accepts a clarification-only model step as a zero-effect question", () => {
    expect(normalizeActionPlan({ actions: [{ action: "clarification", query: "你指的是哪首？" }], confidence: 0.9 }, "陈奕迅那首"))
      .toMatchObject({ actions: [{ action: "noop" }], clarification: { question: "你指的是哪首？" } });
  });

  it("does not replace a valid compound plan with a shorter local interpretation", () => {
    const plan = { actions: [{ action: "play_specific", query: "Target" }, { action: "like", reference: { kind: "current" } }], constraints: [], references: [], confidence: 0.95 };
    expect(normalizeActionPlan(plan, "播放《Target》后再收藏，收藏失败也别重复播放").actions).toEqual(plan.actions);
  });

  it("keeps a resolved previous-track model reference instead of a current replay shortcut", () => {
    const plan = { actions: [{ action: "play_specific", reference: { kind: "recent", index: 1 } }], constraints: [], references: [], confidence: 0.95 };
    expect(normalizeActionPlan(plan, "放刚才那首").actions).toEqual(plan.actions);
  });

  it("does not override a low-confidence plan with the deterministic fallback", () => {
    expect(normalizeActionPlan({
      actions: [{ action: "noop", confidence: 0.6 }],
      constraints: [],
      references: [],
      confidence: 0.6
    }, "能听一首陈奕迅吗")).toMatchObject({
      actions: [{ action: "noop", confidence: 0.6 }],
      confidence: 0.6
    });
  });

  it("keeps clarification when the model omits an executable action", () => {
    expect(normalizeActionPlan({
      actions: [],
      constraints: [],
      references: [],
      confidence: 0.5,
      clarification: { question: "你想听哪一首陈奕迅？" }
    }, "能听一首陈奕迅吗")).toMatchObject({
      actions: [{ action: "noop", confidence: 0.5 }],
      confidence: 0.5,
      clarification: { question: "你想听哪一首陈奕迅？" }
    });
  });

  it("normalizes wrong-for-now feedback to a current-track session correction", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{
                    action: "unlike",
                    reference: { kind: "current" },
                    scope: "long_term",
                    confidence: 0.95
                  }],
                  constraints: [],
                  references: [{ kind: "current" }],
                  confidence: 0.95
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("这首只是现在不合适", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{
        action: "update_session_intent",
        reference: { kind: "current" },
        feedbackReason: "wrong_for_now",
        scope: "session",
        immediate: false,
        confidence: 1
      }],
      constraints: [{ kind: "avoid", value: "当前这首", scope: "session", hard: true }],
      references: [{ kind: "current" }],
      confidence: 1
    });
  });

  it("normalizes a bad-version report without turning it into track dislike", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{ action: "noop", confidence: 0.93 }],
                  constraints: [],
                  references: [],
                  confidence: 0.93
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("当前播放的这个版本有问题", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{
        action: "update_long_term_preference",
        reference: { kind: "current" },
        feedbackReason: "bad_version",
        scope: "session",
        confidence: 1
      }],
      references: [{ kind: "current" }],
      confidence: 1
    });
  });

  it("normalizes playback failure as session-scoped non-taste feedback", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{
                    action: "unlike",
                    reference: { kind: "current" },
                    confidence: 0.97
                  }],
                  constraints: [],
                  references: [{ kind: "current" }],
                  confidence: 0.97
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("是播放出错，不是我不喜欢", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{
        action: "update_session_intent",
        reference: { kind: "current" },
        feedbackReason: "playback_problem",
        scope: "session",
        immediate: false,
        confidence: 1
      }],
      constraints: [],
      references: [{ kind: "current" }],
      confidence: 1
    });
  });

  it("keeps the requested recent-track index when normalizing replay", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  actions: [{
                    action: "replay",
                    reference: { kind: "current" },
                    confidence: 0.96
                  }],
                  constraints: [],
                  references: [{ kind: "current" }],
                  confidence: 0.96
                })
              }
            }]
          })
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.plan("重播刚才第二首", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{
        action: "replay",
        reference: { kind: "recent", index: 2 },
        confidence: 1
      }],
      references: [{ kind: "recent", index: 2 }],
      confidence: 1
    });
  });

  it("turns an indexed recent-track reference into direct playback without a fake query", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    const plan = await assistant.plan("就刚才第二首", { messages: [], queue: [] });

    expect(plan).toMatchObject({
      actions: [{
        action: "play_specific",
        reference: { kind: "recent", index: 2 },
        immediate: true,
        confidence: 1
      }],
      references: [{ kind: "recent", index: 2 }],
      confidence: 1
    });
    expect(plan.actions[0]).not.toHaveProperty("query");
    expect(plan.actions[0]).not.toHaveProperty("searchQuery");
  });

  it("turns an indexed queue reference into immediate playback without a fake query", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    const plan = await assistant.plan("后面第三首换到现在", { messages: [], queue: [] });

    expect(plan).toMatchObject({
      actions: [{
        action: "play_specific",
        reference: { kind: "queue", index: 3 },
        immediate: true,
        confidence: 1
      }],
      references: [{ kind: "queue", index: 3 }],
      confidence: 1
    });
    expect(plan.actions[0]).not.toHaveProperty("query");
    expect(plan.actions[0]).not.toHaveProperty("searchQuery");
  });

  it("builds a deterministic compound plan when no model client is configured", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    await expect(
      assistant.plan("暂停后继续播放", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{ action: "pause" }, { action: "resume" }],
      confidence: 0.9
    });
  });

  it("keeps deterministic favorite commands executable when planning AI is unavailable", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    await expect(
      assistant.plan("收藏这首", { messages: [], queue: [] })
    ).resolves.toMatchObject({
      actions: [{ action: "like", reference: { kind: "current" }, confidence: 1 }],
      references: [{ kind: "current" }],
      confidence: 1
    });
  });

  it("lets the track selector return a source-aware QQ track key", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      chat: {
        completions: {
          create: async (input: Record<string, unknown>) => {
            request = input;
            return { choices: [{ message: { content: '{"trackId":"qq:003abc"}' } }] };
          }
        }
      }
    } as unknown as OpenAI;
    const assistant = new OpenAiDjAssistant({ model: "test-model", client });

    await expect(
      assistant.selectTrack(
        "安静一点",
        [
          { id: "qq:003abc", trackKey: "qq:003abc", title: "QQ 候选", artists: ["歌手"] },
          { id: 42, title: "网易云候选", artists: ["歌手"] }
        ],
        { messages: [], queue: [] }
      )
    ).resolves.toEqual({ trackId: "qq:003abc" });
    expect(JSON.stringify(request)).toContain("number|string");
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

  it("keeps an explicit model-recognized song request even when the local shortcut grammar misses it", () => {
    expect(
      normalizeIntent(
        { type: "play_specific", query: "陈奕迅", searchQuery: "陈奕迅" },
        "能听一首陈奕迅吗"
      )
    ).toEqual({ type: "play_specific", query: "陈奕迅", searchQuery: "陈奕迅" });
  });

  it("preserves scope, feedback reason, and immediate timing in a normalized action plan", () => {
    expect(normalizeActionPlan({
      actions: [{
        action: "update_session_intent",
        description: "接下来安静一点",
        desiredMood: "calm",
        scope: "day",
        feedbackReason: "wrong_for_now",
        immediate: false,
        confidence: 0.96
      }],
      constraints: [{ kind: "mood", value: "calm", scope: "day", hard: true }],
      references: [],
      confidence: 0.96
    }, "今天接下来安静一点")).toMatchObject({
      actions: [{
        action: "update_session_intent",
        scope: "day",
        feedbackReason: "wrong_for_now",
        immediate: false
      }],
      constraints: [{ kind: "mood", value: "calm", scope: "day", hard: true }]
    });
  });

  it("drops secret-bearing model constraints before they can become persistent preferences", () => {
    const plan = normalizeActionPlan({
      actions: [{ action: "update_long_term_preference", confidence: 0.98 }],
      constraints: [
        { kind: "tag", value: "API key sk-live-1234567890abcdef", scope: "long_term" },
        { kind: "tag", value: "session token abc123", scope: "long_term" },
        { kind: "tag", value: "cookie MUSIC_U=private", scope: "long_term" },
        { kind: "tag", value: "password hunter2", scope: "long_term" },
        { kind: "tag", value: "用户密钥 private-value", scope: "long_term" },
        { kind: "tag", value: "abcdefghijklmnopqrstuvwxyz012345", scope: "long_term" },
        { kind: "artist", value: "陈奕迅", scope: "long_term" }
      ],
      references: [],
      confidence: 0.98
    }, "以后多放陈奕迅");

    expect(plan.constraints).toEqual([
      { kind: "artist", value: "陈奕迅", scope: "long_term" }
    ]);
  });

  it("binds top-level track references to actions that require a track target", () => {
    expect(normalizeActionPlan({
      actions: [{ action: "like", confidence: 0.98 }],
      constraints: [],
      references: [{ kind: "current" }],
      confidence: 0.98
    }, "收藏这首")).toMatchObject({
      actions: [{ action: "like", reference: { kind: "current" } }],
      references: [{ kind: "current" }]
    });
  });

  it("keeps a temporary negative music preference as an actionable constraint", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    const plan = await assistant.plan("现在别放摇滚", { messages: [], queue: [] });

    expect(plan).toMatchObject({
      actions: [{
        action: "update_session_intent",
        description: "避免摇滚",
        scope: "session"
      }],
      constraints: [{ kind: "avoid", value: "摇滚", scope: "session", hard: true }]
    });
  });

  it.each([
    ["以后别再放这首", "这首", { kind: "current" }],
    ["不要再放白噪音", "白噪音", undefined]
  ])("keeps %s as a long-term negative preference", async (message, target, reference) => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    const plan = await assistant.plan(message, { messages: [], queue: [] });

    expect(plan).toMatchObject({
      actions: [{
        action: "update_long_term_preference",
        description: `避免${target}`,
        scope: "long_term",
        ...(reference ? { reference } : {})
      }],
      constraints: [{ kind: "avoid", value: target, scope: "long_term", hard: true }]
    });
  });

  it.each(["先别播", "只聊天", "只聊聊这首，不要切歌"])(
    "keeps the explicit no-playback request %s side-effect free",
    async (message) => {
      const assistant = new OpenAiDjAssistant({ model: "test-model" });

      await expect(assistant.plan(message, { messages: [], queue: [] })).resolves.toMatchObject({
        actions: [{ action: "noop" }],
        constraints: []
      });
    }
  );

  it("does not persist a secret mentioned through the deterministic preference fallback", async () => {
    const assistant = new OpenAiDjAssistant({ model: "test-model" });

    const plan = await assistant.plan("以后别再放 API key sk-live-1234567890abcdef", {
      messages: [],
      queue: []
    });

    expect(plan).toMatchObject({ actions: [{ action: "noop" }], constraints: [] });
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
    expect(canFastPathChat("能听一首陈奕迅吗")).toBe(false);
    expect(canFastPathChat("收藏这首，然后换首相似但安静点的")).toBe(false);
    expect(canFastPathChat("重播刚才第二首")).toBe(false);
    expect(canFastPathChat("点一首适合下雨天散步的歌")).toBe(false);
    expect(canFastPathChat("现在别放摇滚")).toBe(false);
    expect(canFastPathChat("不要再放白噪音")).toBe(false);
    expect(canFastPathChat("暂停一下")).toBe(false);
    expect(canFastPathChat("calm please")).toBe(false);
  });
});
