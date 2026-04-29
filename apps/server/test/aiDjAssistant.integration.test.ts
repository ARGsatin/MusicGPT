import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage, Track, TrackStat } from "@musicgpt/shared";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";
import { TtsPipeline } from "../src/ttsPipeline.js";
import type { AiDjAssistant, AiDjContext, AiDjIntent, TrackSelection } from "../src/aiDjAssistant.js";

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
  it("selects a described song from the local library without changing playback", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "雨夜散步，不要太伤", searchQuery: "雨夜 散步" },
        selection: { trackId: 102, reason: "它有雨夜感，但节奏没有彻底塌下去。" }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 101, title: "Sunny Gym", artists: ["Pulse"], moodTag: "energy", playCount: 80 }),
      stat({ id: 102, title: "Rain Walk", artists: ["Nocturne"], album: "Quiet City", moodTag: "night", playCount: 12 })
    ]);

    const response = await postChat(fixture.base, "点一首适合雨夜散步但不要太伤的歌");

    expect(response.action).toBe("play_by_description");
    expect(response.now.track).toBeUndefined();
    expect(response.now.queue).toHaveLength(0);
    expect(response.reply).toContain("Rain Walk");
    expect(response.messages.at(-1)?.role).toBe("assistant");
    const suggestion = response.messages.at(-1)?.trackSuggestion;
    expect(suggestion?.track.id).toBe(102);
    expect(suggestion?.track.songUrl).toBeUndefined();
    expect(fixture.assistant.lastCandidates.map((candidate) => candidate.id)).toContain(102);
    expect(fixture.ncmSearches).toHaveLength(0);
  });

  it("plays a suggested track only after the user clicks the suggestion", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "rain walk", searchQuery: "rain walk" },
        selection: { trackId: 102, reason: "soft night pacing" }
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 102, title: "Rain Walk", artists: ["Nocturne"], album: "Quiet City", moodTag: "night", playCount: 12 })
    ]);

    const response = await postChat(fixture.base, "play something for rain walk");
    const suggestion = response.messages.at(-1)?.trackSuggestion;
    expect(suggestion?.track.id).toBe(102);
    expect(response.now.track).toBeUndefined();

    const playResponse = await postPlayTrack(fixture.base, suggestion!.track, suggestion!.reason);

    expect(playResponse.now.track?.id).toBe(102);
    expect(playResponse.now.track?.songUrl).toBe("https://example.com/102.mp3");
  });

  it("falls back to NCM search when local candidates are weak", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "凌晨写代码的低频电子", searchQuery: "低频 电子" },
        selection: { trackId: 202, reason: "低频线条更适合深夜专注。" }
      }),
      searchTracks: [{ id: 202, title: "Sub Bass Room", artists: ["Kernel"], moodTag: "focus" }]
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 201, title: "Acoustic Morning", artists: ["Bright"], moodTag: "warm", playCount: 3 })
    ]);

    const response = await postChat(fixture.base, "来点凌晨写代码的低频电子");

    expect(response.action).toBe("play_by_description");
    expect(response.now.track).toBeUndefined();
    expect(response.messages.at(-1)?.trackSuggestion?.track.id).toBe(202);
    expect(fixture.ncmSearches).toEqual(["低频 电子"]);
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

  it("adds a free DJ comment after a described song selection", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_by_description", description: "late coding bass", searchQuery: "late coding bass" },
        selection: { trackId: 402, reason: "internal ranking reason" },
        selectedComment: "This one moves like a terminal window left open after midnight."
      })
    });
    fixture.repo.upsertTrackStats([
      stat({ id: 402, title: "Terminal Glow", artists: ["Bit Depth"], moodTag: "focus", playCount: 7 })
    ]);

    const response = await postChat(fixture.base, "play something for late coding bass");

    expect(response.action).toBe("play_by_description");
    expect(response.reply).toContain("Terminal Glow");
    expect(response.reply).toContain("terminal window");
    expect(response.reply).not.toContain("internal ranking reason");
    expect(response.now.track).toBeUndefined();
    expect(response.messages.at(-1)?.trackSuggestion?.track.id).toBe(402);
  });

  it("adds a free DJ comment after a direct song request", async () => {
    const fixture = await createFixture({
      assistant: new FakeAssistant({
        intent: { type: "play_specific", query: "Nevada", searchQuery: "Nevada" },
        selectedComment: "The hook is bright enough for the skyline, but the vocal keeps a little rain in its pocket."
      }),
      searchTracks: [{ id: 403, title: "Nevada", artists: ["Vicetone", "Cozi Zuehlsdorff"], moodTag: "energy" }]
    });

    const response = await postChat(fixture.base, "play Nevada");

    expect(response.action).toBe("play_specific");
    expect(response.now.track).toBeUndefined();
    expect(response.messages.at(-1)?.trackSuggestion?.track.id).toBe(403);
    expect(response.reply).toContain("Nevada");
    expect(response.reply).toContain("skyline");
  });
});

class FakeAssistant implements AiDjAssistant {
  lastContext: AiDjContext | undefined;
  lastCandidates: Track[] = [];

  constructor(
    private readonly options: {
      intent: AiDjIntent;
      selection?: TrackSelection;
      comment?: string;
      selectedComment?: string;
      chatReply?: string;
    }
  ) {}

  status(): { configured: boolean; model?: string; baseUrlConfigured?: boolean; lastError?: string } {
    return { configured: true, model: "fake-dj", baseUrlConfigured: false };
  }

  async classify(_message: string, context: AiDjContext): Promise<AiDjIntent> {
    this.lastContext = context;
    return this.options.intent;
  }

  async selectTrack(_description: string, candidates: Track[], context: AiDjContext): Promise<TrackSelection> {
    this.lastContext = context;
    this.lastCandidates = candidates;
    return this.options.selection ?? { trackId: candidates[0]?.id, reason: "默认选择最接近的一首。" };
  }

  async commentCurrent(context: AiDjContext): Promise<string> {
    this.lastContext = context;
    return this.options.comment ?? "这首歌有自己的阴影和光。";
  }

  async commentTrack(_track: Track, context: AiDjContext, _purpose: string): Promise<string> {
    this.lastContext = context;
    return this.options.selectedComment ?? "A selected-track comment with its own pulse.";
  }

  async chat(_message: string, context: AiDjContext): Promise<string> {
    this.lastContext = context;
    return this.options.chatReply ?? "我在，继续说你的听感。";
  }
}

async function createFixture(options: { assistant: AiDjAssistant; searchTracks?: Track[] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-aidj-"));
  const repo = new StateRepository(path.join(tmp, "state.db"));
  const tts = new TtsPipeline(path.join(tmp, "tts"), "zh-CN-XiaoxiaoNeural", async (_text, filePath) => {
    fs.writeFileSync(filePath, "audio");
  });
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
    ttsPipeline: tts,
    aiDjAssistant: options.assistant,
    djBroadcastInterval: 4,
    importRetryIntervalMs: 50
  });
  servers.push(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, base, repo, assistant: options.assistant as FakeAssistant, ncmSearches };
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

async function postPlayTrack(base: string, track: Track, reason: string) {
  const response = await fetch(`${base}/api/play-track`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, reason })
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as {
    now: { track?: Track; queue: unknown[]; paused: boolean };
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
