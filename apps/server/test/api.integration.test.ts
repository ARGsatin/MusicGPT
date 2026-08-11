import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const target = servers.pop();
    if (target) {
      await target.close();
    }
  }
});

describe("API integration", () => {
  it("jumps to a queued track and consumes the preceding queue items", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-queue-jump-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const queue = Array.from({ length: 10 }, (_, index) => ({
      track: {
        id: 10 + index,
        title: `Queued ${10 + index}`,
        artists: ["Queue Artist"],
        songUrl: `https://example.com/${10 + index}.mp3`
      },
      score: 0.9 - index * 0.01,
      reason: "Queued for later",
      source: "library" as const,
      bucket: "familiar" as const
    }));
    repo.saveNowPlaying({
      track: { id: 1, title: "Current", artists: ["Current Artist"] },
      queue,
      paused: false
    });
    const app = await createServer({
      repo,
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch),
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/queue/13/play"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      now: { track?: { id: number }; queue: Array<{ track: { id: number } }> };
    };
    expect(payload.now.track?.id).toBe(13);
    expect(payload.now.queue.map((item) => item.track.id)).toEqual([14, 15, 16, 17, 18, 19]);
  });

  it("resolves a fresh audio redirect instead of exposing a persisted song URL", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-audio-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const staleTrack = {
      id: 77,
      title: "Signed URL",
      artists: ["Temporary Link"],
      songUrl: "https://expired.example/77.mp3"
    };
    repo.ensureTrack(staleTrack);
    repo.saveNowPlaying({ track: staleTrack, queue: [], paused: false });

    let resolutionRequests = 0;
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", async (input, init) => {
      const url = input.toString();
      if (url.includes("/song/url/v1")) {
        resolutionRequests += 1;
        return json({ data: [{ id: 77, url: "https://fresh.example/77.mp3" }] });
      }
      return mockNcmFetch(input, init);
    });
    const app = await createServer({
      repo,
      ncm,
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tracks/77/audio"
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://fresh.example/77.mp3");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(resolutionRequests).toBe(1);
  });

  it("returns an actionable NCM diagnostic when the dependency is unreachable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-ncm-failure-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const ncm = new NcmConnector(
      "http://mock-ncm",
      "MUSIC_U=test",
      async () => {
        throw new TypeError("fetch failed");
      }
    );
    const app = await createServer({
      repo,
      ncm,
      importRetryIntervalMs: 60_000
    });
    servers.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    const response = await fetch(`${base}/api/import/ncm`, {
      method: "POST"
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      importedCount: 0,
      errorCode: "ncm_unreachable",
      error: expect.stringContaining("无法连接")
    });
  });

  it("syncs chat replan with now endpoint and ws stream", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch);
    const app = await createServer({
      repo,
      ncm,
      djBroadcastInterval: 3
    });
    servers.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    const wsMessage = waitForWsEvent(`${base.replace("http", "ws")}/ws/stream`);

    const chatRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "calm please" })
    });
    expect(chatRes.ok).toBe(true);
    const chatPayload = (await chatRes.json()) as { action: string };
    expect(chatPayload.action).toBe("replan");

    const nowRes = await fetch(`${base}/api/now`);
    const now = (await nowRes.json()) as {
      track?: { id: number };
      lyrics?: { trackId: number; pureMusic: boolean; lines: Array<{ text: string; translation?: string }> };
    };
    expect(now.track?.id).toBeDefined();
    expect(now.lyrics).toMatchObject({
      trackId: now.track?.id,
      pureMusic: false,
      lines: [{ text: "I won't see you tonight", translation: "今晚若见你" }]
    });

    const wsEvent = await wsMessage;
    expect(["queue_updated", "now_playing_updated"]).toContain(wsEvent.event);
  });

  it("permanently clears chat history through the history endpoint", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-chat-clear-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    repo.addChatMessage({ role: "user", text: "keep this?", at: "2026-07-28T08:00:00.000Z" });
    repo.addChatMessage({ role: "assistant", text: "not after clearing", at: "2026-07-28T08:00:01.000Z" });
    const memory = repo.upsertChatMemory({
      category: "preference",
      content: "用户喜欢轻爵士",
      normalizedKey: "preference:jazz"
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch);
    const app = await createServer({
      repo,
      ncm,
      importRetryIntervalMs: 60_000
    });
    servers.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    const beforeResponse = await fetch(`${base}/api/chat/history`);
    const before = (await beforeResponse.json()) as { messages: unknown[] };
    expect(before.messages).toHaveLength(2);

    const clearResponse = await fetch(`${base}/api/chat/history`, { method: "DELETE" });
    expect(clearResponse.ok).toBe(true);
    await expect(clearResponse.json()).resolves.toEqual({ ok: true, messages: [] });

    const afterResponse = await fetch(`${base}/api/chat/history`);
    const after = (await afterResponse.json()) as { messages: unknown[] };
    expect(after.messages).toEqual([]);
    expect(repo.getRecentMessages()).toEqual([]);

    const memoriesResponse = await fetch(`${base}/api/chat/memories`);
    await expect(memoriesResponse.json()).resolves.toMatchObject({
      memories: [expect.objectContaining({ id: memory.id, content: "用户喜欢轻爵士" })]
    });

    const deleteMemoryResponse = await fetch(`${base}/api/chat/memories/${memory.id}`, {
      method: "DELETE"
    });
    expect(deleteMemoryResponse.ok).toBe(true);
    await expect(fetch(`${base}/api/chat/memories`).then((response) => response.json())).resolves.toEqual({
      memories: []
    });

    repo.upsertChatMemory({
      category: "habit",
      content: "用户睡前听音乐",
      normalizedKey: "habit:bedtime"
    });
    const clearMemoriesResponse = await fetch(`${base}/api/chat/memories`, {
      method: "DELETE"
    });
    await expect(clearMemoriesResponse.json()).resolves.toEqual({ ok: true, memories: [] });
  });
});

function waitForWsEvent(url: string): Promise<{ event: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
    const socket = new WebSocket(url);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(event.data)) as { event: string });
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event);
    });
  });
}

const mockNcmFetch: typeof fetch = async (input) => {
  const url = input.toString();
  if (url.includes("/user/account")) {
    return json({
      account: { id: 9527, anonimousUser: false, status: 0 },
      profile: { userId: 9527 }
    });
  }
  if (url.includes("/likelist")) {
    return json({ ids: [{ id: 1, t: Date.now() }, { id: 2, t: Date.now() - 10000 }] });
  }
  if (url.includes("/song/detail")) {
    return json({
      songs: [
        { id: 1, name: "Sunlight", ar: [{ name: "Alpha" }], dt: 210000 },
        { id: 2, name: "Moonlight", ar: [{ name: "Beta" }], dt: 220000 }
      ]
    });
  }
  if (url.includes("/user/record")) {
    return json({
      allData: [
        { playCount: 100, song: { id: 1, name: "Sunlight", ar: [{ name: "Alpha" }] } },
        { playCount: 88, song: { id: 2, name: "Moonlight", ar: [{ name: "Beta" }] } }
      ]
    });
  }
  if (url.includes("/song/url/v1")) {
    if (url.includes("id=1")) {
      return json({ data: [{ id: 1, url: "https://example.com/1.mp3" }] });
    }
    return json({ data: [{ id: 2, url: "https://example.com/2.mp3" }] });
  }
  if (url.includes("/lyric")) {
    return json({
      nolyric: false,
      lrc: {
        lyric: "[00:05.720]I won't see you tonight"
      },
      tlyric: {
        lyric: "[00:05.720]今晚若见你"
      }
    });
  }
  if (url.includes("/cloudsearch")) {
    return json({ result: { songs: [{ id: 1, name: "Sunlight", artists: [{ name: "Alpha" }] }] } });
  }
  return json({});
};

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
