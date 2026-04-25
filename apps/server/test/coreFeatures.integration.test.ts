import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  it("records completion via feedback and triggers DJ by completed tracks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-core-"));
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
    expect(thirdNow.djScript?.text.length).toBeGreaterThan(0);
  });

  it("updates liked_at and exposes status/import endpoints", async () => {
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
    await sendFeedback(base, "like", now.track!.id);
    const liked = repo.getTrackStats(50).find((item) => item.track.id === now.track!.id);
    expect(liked?.likedAt).toBeDefined();

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
      return json({ result: { songs: [] } });
    }
    return json({});
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
