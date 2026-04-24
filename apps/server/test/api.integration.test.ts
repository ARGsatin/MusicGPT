import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

describe("API integration", () => {
  it("syncs chat replan with now endpoint and ws stream", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-api-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const tts = new TtsPipeline(path.join(tmp, "tts"), "zh-CN-XiaoxiaoNeural", async (_text, filePath) => {
      fs.writeFileSync(filePath, "audio");
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch);
    const app = await createServer({
      repo,
      ncm,
      ttsPipeline: tts,
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
    const now = (await nowRes.json()) as { track?: { id: number } };
    expect(now.track?.id).toBeDefined();

    const wsEvent = await wsMessage;
    expect(["queue_updated", "now_playing_updated"]).toContain(wsEvent.event);
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
