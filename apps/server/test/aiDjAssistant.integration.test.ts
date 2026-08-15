import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage, Track, TrackStat } from "@musicgpt/shared";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";
import {
  OpenAiDjAssistant,
  type AiDjAssistant,
  type AiDjContext,
  type AiDjIntent,
  type TrackSelection
} from "../src/aiDjAssistant.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const target = servers.pop();
    if (target) {
      await target.close();
    }
  }
});

describe("AI DJ assistant chat", () => {
  it("never exposes a local canned review for a direct request when AI is unavailable", async () => {
    const fixture = await createFixture({
      assistant: new OpenAiDjAssistant({ model: "test-model" }),
      searchTracks: [{ id: 1, title: "In The End", artists: ["Linkin Park"] }]
    });

    const response = await postChat(fixture.base, "播放 《In The End》");

    expect(response.action).toBe("play_specific");
    expect(response.reply).toBe("已切到《In The End》— Linkin Park。");
    expect(response.reply).not.toMatch(/分寸感|重点到了|扑得太满/);
  });

  it("streams model text before returning the persisted result", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "chat" },
        chatDeltas: ["好呀，", "今天听点轻快的。", "再来一首！"]
      })
    });

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "陪我听歌" })
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        delta?: string;
        response?: { reply: string; messages: ChatMessage[] };
      });

    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      "好呀，今天听点轻快的。再来一首！"
    ]);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "result"]);
    const result = events.find((event) => event.type === "result")?.response;
    expect(result?.reply).toBe("好呀，今天听点轻快的。再来一首！");
    expect(result?.messages.at(-1)).toMatchObject({
      id: expect.any(Number),
      role: "assistant",
      text: "好呀，今天听点轻快的。再来一首！"
    });
  });

  it("shows an honest provider failure without exposing the upstream error", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "chat" },
        streamError: new Error("upstream stream broke")
      })
    });

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "还在吗" })
    });
    const body = await response.text();

    expect(body).toContain("DeepSeek 暂时没能生成可信的回复，请重试。");
    expect(body).not.toContain("upstream stream broke");
  });

  it("does not invent a local chat reply when no AI provider is configured", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        configured: false,
        intent: { type: "chat" },
        chatReply: "好呀，我懂你想要的感觉了～"
      })
    });

    const response = await postChat(fixture.base, "还在吗");

    expect(response.reply).toBe("尚未连接 DeepSeek/OpenAI，当前无法生成开放式回复。");
    expect(response.reply).not.toContain("好呀");
  });

  it("selects and plays a described song from the local library", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "雨夜散步，不要太伤", searchQuery: "雨夜 散步" },
        selection: { trackId: 102 }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 101, title: "Sunny Gym", artists: ["Pulse"], moodTag: "energy", playCount: 80 }),
      stat({ id: 102, title: "Rain Walk", artists: ["Nocturne"], album: "Quiet City", moodTag: "night", playCount: 12 })
    ]);

    const response = await postChat(fixture.base, "点一首适合雨夜散步但不要太伤的歌");

    expect(response.action).toBe("play_by_description");
    expect(response.now.track?.id).toBe(102);
    expect(response.now.track?.songUrl).toBe("https://example.com/102.mp3");
    expect(response.reply).toContain("Rain Walk");
    expect(response.reply).toContain("散步通勤");
    expect(response.reply).toContain("夜听");
    expect(response.reply).not.toContain("给你～");
    expect(response.messages.at(-1)?.role).toBe("assistant");
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
    expect(fixture.assistant.lastCandidates.map((candidate) => candidate.id)).toContain(102);
    expect(fixture.ncmSearches).toHaveLength(0);
  });

  it("resolves the playback URL without requiring a suggestion click", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "rain walk", searchQuery: "rain walk" },
        selection: { trackId: 102 }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 102, title: "Rain Walk", artists: ["Nocturne"], album: "Quiet City", moodTag: "night", playCount: 12 })
    ]);

    const response = await postChat(fixture.base, "play something for rain walk");
    expect(response.now.track?.id).toBe(102);
    expect(response.now.track?.songUrl).toBe("https://example.com/102.mp3");
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("falls back to NCM search when local candidates are weak", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "凌晨写代码的低频电子", searchQuery: "低频 电子" },
        selection: { trackId: 202 }
      }),
      searchTracks: [{ id: 202, title: "Sub Bass Room", artists: ["Kernel"], moodTag: "focus" }]
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 201, title: "Acoustic Morning", artists: ["Bright"], moodTag: "warm", playCount: 3 })
    ]);

    const response = await postChat(fixture.base, "来点凌晨写代码的低频电子");

    expect(response.action).toBe("play_by_description");
    expect(response.now.track?.id).toBe(202);
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
    expect(fixture.ncmSearches).toEqual(["低频 电子"]);
  });

  it("filters ambient search results from an ordinary described-song request", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "雨夜散步", searchQuery: "雨夜 散步" },
        selection: { trackId: 210 }
      }),
      searchTracks: [
        { id: 210, title: "雷雨声 白噪音 ASMR", artists: ["Nature Lab"] },
        { id: 211, title: "Rain Walk", artists: ["Nocturne"], moodTag: "night" }
      ]
    });
    const response = await postChat(fixture.base, "来点雨夜散步的歌");

    expect(response.now.track?.id).toBe(211);
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("keeps ambient search results when the user explicitly requests them", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: {
          type: "play_by_description",
          description: "雨声白噪音助眠",
          searchQuery: "雨声 白噪音 助眠"
        },
        selection: { trackId: 212 }
      }),
      searchTracks: [
        { id: 212, title: "雷雨声 白噪音 ASMR", artists: ["Nature Lab"] }
      ]
    });

    const response = await postChat(fixture.base, "播放雨声白噪音助眠");

    expect(response.now.track?.id).toBe(212);
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("keeps built-in operation replies functional and neutral", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "pause" }
      })
    });

    const response = await postChat(fixture.base, "先暂停一下");

    expect(response.action).toBe("pause");
    expect(response.reply).toBe("已暂停播放。");
    expect(response.reply).not.toMatch(/[呀啦～]|夜色|唱针|灵魂|骨相/);
  });

  it("comments on the current track without changing playback", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "comment_current" },
        comment: "这首歌的鼓组像夜里没睡醒的心跳，低频很克制，旋律却在偷偷开窗。"
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 301, title: "Midnight Window", artists: ["Deep Neon"], moodTag: "night", playCount: 20 })
    ]);
    await requestNext(fixture.base);

    const response = await postChat(fixture.base, "点评当前这首");

    expect(response.action).toBe("comment_current");
    expect(response.now.track?.id).toBe(301);
    expect(response.reply).toContain("低频");
    expect(fixture.assistant.lastContext?.nowTrack?.title).toBe("Midnight Window");
  });

  it("uses an honest notice when an explicit song comment cannot be generated", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "comment_current" },
        commentError: new Error("quality rejected")
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 303, title: "Plain Facts", artists: ["Direct"], moodTag: "focus", playCount: 4 })
    ]);
    await requestNext(fixture.base);

    const response = await postChat(fixture.base, "点评当前这首");

    expect(response.reply).toBe("DeepSeek 暂时没能生成可信的点评；这次不使用本地套话。");
    expect(response.reply).not.toMatch(/分寸感|重点到了|扑得太满/);
  });

  it("buffers a current-track comment before emitting the accepted review", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "comment_current" },
        commentDeltas: ["鼓点很轻，", "但弹性特别好呀。"]
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 302, title: "Soft Bounce", artists: ["Lumi"], moodTag: "warm", playCount: 8 })
    ]);
    await requestNext(fixture.base);

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "点评当前这首" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; delta?: string });

    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      "鼓点很轻，但弹性特别好呀。"
    ]);
  });

  it("persists recent chat history through the history endpoint", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "chat" },
        chatReply: "我记住了：今晚要冷一点、深一点，但别把人送走。"
      })
    });

    await postChat(fixture.base, "今晚想听冷一点但不要太丧");
    const historyRes = await fetch(`${fixture.base}/api/chat/history`);

    expect(historyRes.ok).toBe(true);
    const history = (await historyRes.json()) as { messages: ChatMessage[] };
    expect(history.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.messages[0]?.text).toContain("冷一点");
  });

  it("describes a song selection with structured evidence instead of an automatic review", async () => {
    const assistant = new FakeAssistant({
      intent: { type: "play_by_description", description: "late coding bass", searchQuery: "late coding bass" },
      selection: { trackId: 402 },
      selectedComment: "This one moves like a terminal window left open after midnight."
    });
    const fixture = await createFixture({
      assistant
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 402, title: "Terminal Glow", artists: ["Bit Depth"], moodTag: "focus", playCount: 7 })
    ]);

    const response = await postChat(fixture.base, "play something for late coding bass");

    expect(response.action).toBe("play_by_description");
    expect(response.reply).toContain("Terminal Glow");
    expect(response.reply).toContain("专注");
    expect(response.reply).not.toContain("terminal window");
    expect(response.now.track?.id).toBe(402);
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
    expect(assistant.commentTrackCalls).toBe(0);
  });

  it("returns a factual result after a direct song request", async () => {
    const assistant = new FakeAssistant({
      intent: { type: "play_specific", query: "Nevada", searchQuery: "Nevada" },
      selectedComment: "The hook is bright enough for the skyline, but the vocal keeps a little rain in its pocket."
    });
    const fixture = await createFixture({
      assistant,
      searchTracks: [{ id: 403, title: "Nevada", artists: ["Vicetone", "Cozi Zuehlsdorff"], moodTag: "energy" }]
    });

    const response = await postChat(fixture.base, "play Nevada");

    expect(response.action).toBe("play_specific");
    expect(response.now.track?.id).toBe(403);
    expect(response.messages.at(-1)?.trackSuggestion).toBeUndefined();
    expect(response.reply).toContain("Nevada");
    expect(response.reply).toBe("已切到《Nevada》— Vicetone / Cozi Zuehlsdorff。");
    expect(response.reply).not.toContain("skyline");
    expect(assistant.commentTrackCalls).toBe(0);
  });

  it("emits one factual result after a direct song-search result", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_specific", query: "Nevada", searchQuery: "Nevada" },
        selectedCommentDeltas: ["副歌很亮，", "人声又留了一点雨意呀。"]
      }),
      searchTracks: [{ id: 404, title: "Nevada", artists: ["Vicetone"], moodTag: "energy" }]
    });

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "play Nevada" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        delta?: string;
        response?: { now: { track?: Track }; messages: ChatMessage[] };
      });
    const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);

    expect(deltas).toEqual(["已切到《Nevada》— Vicetone。"]);
    const result = events.find((event) => event.type === "result")?.response;
    expect(result?.now.track?.id).toBe(404);
    expect(result?.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("switches tracks directly when streaming chat recognizes an explicit song request", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_specific", query: "Nevada", searchQuery: "Nevada" }
      }),
      searchTracks: [{ id: 414, title: "Nevada", artists: ["Vicetone"], moodTag: "energy" }]
    });

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "播放 Nevada" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        response?: {
          now: { track?: Track };
          messages: ChatMessage[];
        };
      });
    const result = events.find((event) => event.type === "result")?.response;

    expect(result?.now.track?.id).toBe(414);
    expect(result?.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("switches tracks directly when streaming chat recognizes a described-song request", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: {
          type: "play_by_description",
          description: "适合下雨散步",
          searchQuery: "下雨 散步"
        },
        selection: { trackId: 415 }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 415, title: "Rainy Steps", artists: ["Mori"], moodTag: "calm", playCount: 20 })
    ]);

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "点一首适合下雨散步的歌" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        response?: {
          now: { track?: Track };
          messages: ChatMessage[];
        };
      });
    const result = events.find((event) => event.type === "result")?.response;

    expect(result?.now.track?.id).toBe(415);
    expect(result?.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("switches tracks directly when streaming chat recognizes an atmosphere request", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_atmosphere" },
        selection: { trackId: 416 }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 416, title: "Morning Signal", artists: ["North Loop"], moodTag: "focus", playCount: 12 })
    ]);
    fixture.repo.saveEnvironmentContext({
      weather: "clear",
      dayPeriod: "morning",
      updatedAt: new Date().toISOString()
    });

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "根据现在的天气和时间点歌" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        response?: {
          now: { track?: Track };
          messages: ChatMessage[];
        };
      });
    const result = events.find((event) => event.type === "result")?.response;

    expect(result?.now.track?.id).toBe(416);
    expect(result?.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("emits one evidence-based result after a described-song selection", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: {
          type: "play_by_description",
          description: "适合下雨散步",
          searchQuery: "下雨 散步"
        },
        selection: { trackId: 405 },
        selectedCommentDeltas: ["吉他很松弛，", "雨里走路正合适呀。"]
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 405, title: "Rainy Steps", artists: ["Mori"], moodTag: "calm", playCount: 20 })
    ]);

    const response = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "点一首适合下雨散步的歌" })
    });
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        delta?: string;
        response?: { now: { track?: Track }; messages: ChatMessage[] };
      });
    const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.delta);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toContain("散步通勤");
    expect(deltas[0]).toContain("Rainy Steps");
    expect(deltas[0]).not.toContain("吉他很松弛");
    const result = events.find((event) => event.type === "result")?.response;
    expect(result?.now.track?.id).toBe(405);
    expect(result?.messages.at(-1)?.trackSuggestion).toBeUndefined();
  });

  it("uses factual atmosphere evidence in both chat endpoints without requesting a review", async () => {
    const assistant = new FakeAssistant({
      intent: { type: "play_atmosphere" },
      selection: { trackId: 406 },
      selectedComment: "A generic atmospheric review that must never be requested."
    });
    const fixture = await createFixture({ assistant });
    fixture.repo.upsertTrackStats([
      stat({ id: 406, title: "Morning Signal", artists: ["North Loop"], moodTag: "focus", playCount: 12 })
    ]);
    fixture.repo.saveEnvironmentContext({
      weather: "clear",
      dayPeriod: "morning",
      updatedAt: new Date().toISOString()
    });
    const regular = await postChat(fixture.base, "根据现在的天气和时间点歌");
    expect(regular.action).toBe("play_atmosphere");
    const regularReason = regular.reply.split("，已切到")[0];
    expect(regularReason).toMatch(/^晴天 · (早晨|午后|傍晚|深夜) · 熟悉偏好$/);
    expect(regular.reply).toBe(`${regularReason}，已切到《Morning Signal》— North Loop。`);
    expect(regular.now.track?.id).toBe(406);
    expect(regular.messages.at(-1)?.trackSuggestion).toBeUndefined();

    const streamResponse = await fetch(`${fixture.base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "来点适合现在氛围的歌" })
    });
    const events = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        delta?: string;
        response?: { now: { track?: Track }; messages: ChatMessage[] };
      });
    const streamedReply = events.find((event) => event.type === "text_delta")?.delta;
    const streamedReason = streamedReply?.split("，已切到")[0];
    expect(streamedReason).toMatch(/^晴天 · (早晨|午后|傍晚|深夜) · 熟悉偏好$/);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      `${streamedReason}，已切到《Morning Signal》— North Loop。`
    ]);
    const streamedResult = events.find((event) => event.type === "result")?.response;
    expect(streamedResult?.now.track?.id).toBe(406);
    expect(streamedResult?.messages.at(-1)?.trackSuggestion).toBeUndefined();
    expect(assistant.commentTrackCalls).toBe(0);
  });
});

class FakeAssistant implements AiDjAssistant {
  lastContext: AiDjContext | undefined;
  lastCandidates: Track[] = [];
  commentTrackCalls = 0;

  constructor(
    private readonly options: {
      configured?: boolean;
      intent: AiDjIntent;
      selection?: TrackSelection;
      comment?: string;
      commentError?: Error;
      commentDeltas?: string[];
      selectedComment?: string;
      selectedCommentDeltas?: string[];
      chatReply?: string;
      chatDeltas?: string[];
      streamError?: Error;
    }
  ) {}

  status(): { configured: boolean; provider: string; model?: string; baseUrlConfigured?: boolean; lastError?: string } {
    return {
      configured: this.options.configured ?? true,
      provider: "fake",
      model: "fake-dj",
      baseUrlConfigured: false
    };
  }

  async classify(_message: string, context: AiDjContext): Promise<AiDjIntent> {
    this.lastContext = context;
    return this.options.intent;
  }

  async selectTrack(_description: string, candidates: Track[], context: AiDjContext): Promise<TrackSelection> {
    this.lastContext = context;
    this.lastCandidates = candidates;
    return this.options.selection ?? { trackId: candidates[0]?.id };
  }

  async commentCurrent(context: AiDjContext): Promise<string> {
    this.lastContext = context;
    if (this.options.commentError) {
      throw this.options.commentError;
    }
    return this.options.commentDeltas?.join("") ?? this.options.comment ?? "这首歌有自己的阴影和光。";
  }

  async commentTrack(_track: Track, context: AiDjContext, _purpose: string): Promise<string> {
    this.lastContext = context;
    this.commentTrackCalls += 1;
    return this.options.selectedComment ?? "A selected-track comment with its own pulse.";
  }

  async chat(_message: string, context: AiDjContext): Promise<string> {
    this.lastContext = context;
    if (this.options.streamError) {
      throw this.options.streamError;
    }
    return this.options.chatDeltas?.join("") ?? this.options.chatReply ?? "我在，继续说你的听感。";
  }
}

async function createFixture(options: {
  assistant: AiDjAssistant;
  searchTracks?: Track[];
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-aidj-"));
  const repo = new StateRepository(path.join(tmp, "state.db"));
  const ncmSearches: string[] = [];
  const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", async (input) => {
    const url = input.toString();
    if (url.includes("/login/status") || url.includes("/user/account")) {
      return json({ account: { id: 1, status: 0 }, profile: { userId: 1 } });
    }
    if (url.includes("/likelist")) {
      return json({ ids: [] });
    }
    if (url.includes("/user/record")) {
      return json({ allData: [] });
    }
    if (url.includes("/song/detail")) {
      return json({ songs: [] });
    }
    if (url.includes("/song/url/v1")) {
      const id = Number(url.match(/id=(\d+)/)?.[1] ?? 0);
      return json({ data: [{ id, url: `https://example.com/${id}.mp3` }] });
    }
    if (url.includes("/cloudsearch")) {
      const keyword = decodeURIComponent(url.match(/keywords=([^&]+)/)?.[1] ?? "");
      ncmSearches.push(keyword);
      return json({
        result: {
          songs: (options.searchTracks ?? []).map((track) => ({
            id: track.id,
            name: track.title,
            artists: track.artists.map((name) => ({ name })),
            album: { name: track.album, picUrl: track.coverUrl },
            duration: track.durationMs
          }))
        }
      });
    }
    return json({});
  });
  const app = await createServer({
    repo,
    ncm,
    aiDjAssistant: options.assistant,
    djBroadcastInterval: 4,
    importRetryIntervalMs: 50
  });
  servers.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, base, repo, assistant: options.assistant as unknown as FakeAssistant, ncmSearches };
}

async function postChat(base: string, message: string) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message })
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as {
    action: string;
    reply: string;
    now: { track?: Track; queue: unknown[]; paused: boolean };
    messages: Array<ChatMessage & { trackSuggestion?: { track: Track; reason: string } }>;
  };
}

async function requestNext(base: string) {
  const response = await fetch(`${base}/api/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  expect(response.ok).toBe(true);
  return response.json();
}

function stat(input: Track & { playCount: number }): TrackStat {
  const { playCount, ...track } = input;
  return { track, playCount };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
