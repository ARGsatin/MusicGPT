import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AiDjAssistant } from "../src/aiDjAssistant.js";
import { fallbackClassify } from "../src/aiDjAssistant.js";
import type { EnvironmentService } from "../src/environmentService.js";
import { DjBrain } from "../src/djBrain.js";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";
import { TtsPipeline } from "../src/ttsPipeline.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const target = servers.pop();
    if (target) {
      await target.close();
    }
  }
});

describe("core feature integration", () => {
  it("exposes V1.5 environment, recommendation import, and DJ settings endpoints", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-v15-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const tts = new TtsPipeline(path.join(tmp, "tts"), "zh-CN-XiaoxiaoNeural", async (_text, filePath) => {
      fs.writeFileSync(filePath, "audio");
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", createMockNcmFetch());
    const environmentService: Pick<EnvironmentService, "getContext" | "updateLocation"> = {
      getContext: () => ({
        dayPeriod: "late_night",
        weather: "rain",
        temperature: 17,
        location: { latitude: 31.23, longitude: 121.47 },
        updatedAt: new Date().toISOString()
      }),
      updateLocation: async (location) => ({
        dayPeriod: "late_night",
        weather: "rain",
        temperature: 17,
        location,
        updatedAt: new Date().toISOString()
      })
    };
    const app = await createServer({
      repo,
      ncm,
      aiDjAssistant: createLocalAssistant(),
      djBrain: new DjBrain(),
      ttsPipeline: tts,
      environmentService,
      djBroadcastInterval: 4,
      importRetryIntervalMs: 50
    });
    servers.push(app);

    const base = await app.listen({ port: 0, host: "127.0.0.1" });

    const locationRes = await fetch(`${base}/api/environment/location`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latitude: 31.23, longitude: 121.47 })
    });
    expect(locationRes.ok).toBe(true);
    const environment = (await locationRes.json()) as { weather: string; location: { latitude: number } };
    expect(environment.weather).toBe("rain");
    expect(environment.location.latitude).toBe(31.23);

    const importRes = await fetch(`${base}/api/recommendations/import`, { method: "POST" });
    expect(importRes.ok).toBe(true);
    const importPayload = (await importRes.json()) as { importedCount: number; skippedCount: number };
    expect(importPayload.importedCount).toBeGreaterThan(0);
    expect(importPayload.skippedCount).toBeGreaterThanOrEqual(0);

    const atmosphereRes = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "来点适合现在氛围的歌" })
    });
    expect(atmosphereRes.ok).toBe(true);
    const atmosphere = (await atmosphereRes.json()) as {
      action: string;
      messages: Array<{ trackSuggestion?: { reason: string } }>;
    };
    expect(atmosphere.action).toBe("play_atmosphere");
    expect(atmosphere.messages.at(-1)?.trackSuggestion?.reason).toMatch(/雨天|深夜|日推|氛围/);

    const settingsRes = await fetch(`${base}/api/dj/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tone: "lively", voiceGender: "female", voice: "zh-CN-XiaoxiaoNeural" })
    });
    expect(settingsRes.ok).toBe(true);
    const settings = (await settingsRes.json()) as { tone: string; voiceGender: string; voice: string };
    expect(settings).toEqual({
      tone: "lively",
      voiceGender: "female",
      voice: "zh-CN-XiaoxiaoNeural"
    });
  });

  it("records completion but skips scheduled DJ output when AI is unavailable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-core-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const spoken: string[] = [];
    const tts = new TtsPipeline(path.join(tmp, "tts"), "zh-CN-XiaoxiaoNeural", async (_text, filePath) => {
      spoken.push(_text);
      fs.writeFileSync(filePath, "audio");
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", createMockNcmFetch());
    const app = await createServer({
      repo,
      ncm,
      djBrain: new DjBrain(),
      ttsPipeline: tts,
      djBroadcastInterval: 2,
      importRetryIntervalMs: 50
    });
    servers.push(app);

    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const firstNow = await requestNext(base);
    expect(firstNow.track?.id).toBeDefined();
    expect(repo.getRecentPlayEvents(20)).toHaveLength(0);

    await sendFeedback(base, "complete", firstNow.track!.id);
    const afterFirstComplete = repo.getRecentPlayEvents(20);
    expect(afterFirstComplete[0]?.type).toBe("complete");

    const secondNow = await requestNext(base);
    expect(secondNow.djScript).toBeUndefined();

    await sendFeedback(base, "complete", secondNow.track!.id);
    const thirdNow = await requestNext(base);
    expect(thirdNow.track?.id).toBeDefined();
    expect(thirdNow.djScript).toBeUndefined();
    expect(spoken).toEqual([]);
  });

  it("updates local favorite state and exposes status/import endpoints", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-status-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const tts = new TtsPipeline(path.join(tmp, "tts"), "zh-CN-XiaoxiaoNeural", async (_text, filePath) => {
      fs.writeFileSync(filePath, "audio");
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", createMockNcmFetch());
    const app = await createServer({
      repo,
      ncm,
      djBrain: new DjBrain(),
      ttsPipeline: tts,
      djBroadcastInterval: 4,
      importRetryIntervalMs: 50
    });
    servers.push(app);

    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const statusRes = await fetch(`${base}/api/system/status`);
    expect(statusRes.ok).toBe(true);
    const status = (await statusRes.json()) as {
      runningRoot: string;
      ncmReachable: boolean;
      trackStatsCount: number;
      queueLength: number;
    };
    expect(status.runningRoot.length).toBeGreaterThan(0);
    expect(status.ncmReachable).toBe(true);
    expect(status.trackStatsCount).toBeGreaterThan(0);
    expect(status.queueLength).toBeGreaterThanOrEqual(0);

    const now = await requestNext(base);
    const favoriteRes = await fetch(`${base}/api/favorites/${now.track!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true })
    });
    expect(favoriteRes.ok).toBe(true);
    const favoritePayload = (await favoriteRes.json()) as {
      favorite: boolean;
      taste: { preferenceTags: Array<{ value: string }> };
    };
    expect(favoritePayload.favorite).toBe(true);
    expect(favoritePayload.taste.preferenceTags.length).toBeGreaterThan(0);
    expect(repo.getTrackStats(50).find((item) => item.track.id === now.track!.id)?.localFavoritedAt)
      .toBeDefined();

    const duplicateFavoriteRes = await fetch(`${base}/api/favorites/${now.track!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true })
    });
    expect(duplicateFavoriteRes.ok).toBe(true);
    expect(repo.getRecentPlayEvents(20).filter((event) => event.type === "like")).toHaveLength(1);

    const unfavoriteRes = await fetch(`${base}/api/favorites/${now.track!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: false })
    });
    expect(unfavoriteRes.ok).toBe(true);
    expect(repo.getTrackStats(50).find((item) => item.track.id === now.track!.id)?.localFavoritedAt)
      .toBeUndefined();

    await sendFeedback(base, "like", now.track!.id);
    expect(repo.getTrackStats(50).find((item) => item.track.id === now.track!.id)?.localFavoritedAt)
      .toBeDefined();

    const importRes = await fetch(`${base}/api/import/ncm`, {
      method: "POST"
    });
    expect(importRes.ok).toBe(true);
    const payload = (await importRes.json()) as {
      ok: boolean;
      importedCount: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.importedCount).toBeGreaterThan(0);
  });
});

async function requestNext(base: string) {
  const response = await fetch(`${base}/api/next`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  expect(response.ok).toBe(true);
  const payload = (await response.json()) as {
    now: {
      track?: { id: number };
      djScript?: { text: string };
      queue: Array<unknown>;
      paused: boolean;
    };
  };
  return payload.now;
}

async function sendFeedback(base: string, type: "complete" | "like", trackId: number) {
  const response = await fetch(`${base}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, trackId })
  });
  expect(response.ok).toBe(true);
}

function createMockNcmFetch(): typeof fetch {
  return async (input) => {
    const url = input.toString();
    if (url.includes("/login/status")) {
      return json({
        data: {
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        }
      });
    }
    if (url.includes("/user/account")) {
      return json({
        account: { id: 9527, anonimousUser: false, status: 0 },
        profile: { userId: 9527 }
      });
    }
    if (url.includes("/likelist")) {
      return json({
        ids: [
          { id: 1, t: Date.now() - 1000 },
          { id: 2, t: Date.now() - 2000 },
          { id: 3, t: Date.now() - 3000 },
          { id: 4, t: Date.now() - 4000 }
        ]
      });
    }
    if (url.includes("/song/detail")) {
      return json({
        songs: [
          { id: 1, name: "Alpha", ar: [{ name: "A" }], dt: 210000 },
          { id: 2, name: "Beta", ar: [{ name: "B" }], dt: 220000 },
          { id: 3, name: "Gamma", ar: [{ name: "C" }], dt: 230000 },
          { id: 4, name: "Delta", ar: [{ name: "D" }], dt: 240000 }
        ]
      });
    }
    if (url.includes("/user/record")) {
      return json({
        allData: [
          { playCount: 90, song: { id: 1, name: "Alpha", ar: [{ name: "A" }] } },
          { playCount: 80, song: { id: 2, name: "Beta", ar: [{ name: "B" }] } },
          { playCount: 70, song: { id: 3, name: "Gamma", ar: [{ name: "C" }] } },
          { playCount: 60, song: { id: 4, name: "Delta", ar: [{ name: "D" }] } }
        ]
      });
    }
    if (url.includes("/song/url/v1")) {
      const match = url.match(/id=(\d+)/);
      const id = Number(match?.[1] ?? 0);
      return json({
        data: [{ id, url: `https://example.com/${id}.mp3` }]
      });
    }
    if (url.includes("/cloudsearch")) {
      return json({
        result: {
          songs: [
            {
              id: 8801,
              name: "Rain Window",
              artists: [{ name: "Cloud DJ" }],
              album: { name: "Weather Signals" },
              duration: 205000
            }
          ]
        }
      });
    }
    return json({});
  };
}

function createLocalAssistant(): AiDjAssistant {
  return {
    status: () => ({ configured: false, provider: "local" }),
    classify: async (message) => fallbackClassify(message),
    selectTrack: async (_description, candidates) => ({
      trackId: candidates[0]?.id
    }),
    commentTrack: async (track) => `这首《${track.title}》和现在的氛围很合拍。`,
    commentCurrent: async () => "正在播放的这首很合适。",
    chat: async () => "本地 DJ 在线。"
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
