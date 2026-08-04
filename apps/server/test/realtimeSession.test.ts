import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import {
  buildRealtimeSessionConfig,
  createRealtimeSession,
  resolveRealtimeSessionUrl
} from "../src/realtimeSession.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("Realtime speech session", () => {
  it("exchanges raw browser SDP for a Qwen3.5 Omni Realtime session", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("v=0\r\no=qwen-answer", {
        status: 200,
        headers: { "content-type": "application/sdp" }
      })
    );

    const answer = await createRealtimeSession({
      apiKey: "server-secret",
      offerSdp: "v=0\r\no=browser-offer",
      fetchFn
    });

    expect(answer).toBe("v=0\r\no=qwen-answer");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer server-secret",
          "Content-Type": "application/sdp"
        },
        body: "v=0\r\no=browser-offer"
      })
    );
  });

  it("uses a configured DashScope workspace endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("v=0\r\no=qwen-answer", {
        status: 200,
        headers: { "content-type": "application/sdp" }
      })
    );

    await createRealtimeSession({
      apiKey: "dashscope-secret",
      workspaceId: "llm-aurora123",
      offerSdp: "v=0\r\no=browser-offer",
      fetchFn
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://llm-aurora123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer dashscope-secret" })
      })
    );
  });

  it("builds the Qwen session update with semantic VAD, Tina, and nested function tools", () => {
    expect(buildRealtimeSessionConfig()).toMatchObject({
      modalities: ["text", "audio"],
      voice: "Tina",
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      turn_detection: { type: "semantic_vad" },
      tools: [
        { type: "function", function: { name: "run_music_command" } },
        { type: "function", function: { name: "wait_for_user" } }
      ]
    });
  });

  it("rejects an unsafe workspace ID before constructing a hostname", () => {
    expect(() => resolveRealtimeSessionUrl(undefined, "bad.example.com/path"))
      .toThrow("invalid_dashscope_workspace_id");
  });

  it("exposes the SDP exchange through the app without returning the DashScope key", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-realtime-route-"));
    const realtimeFetch = vi.fn<typeof fetch>(async () =>
      new Response("v=0\r\no=qwen-answer", {
        status: 200,
        headers: { "content-type": "application/sdp" }
      })
    );
    const app = await createServer({
      repo: new StateRepository(path.join(tmp, "state.db")),
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", async () =>
        new Response("{}", { headers: { "content-type": "application/json" } })
      ),
      realtimeApiKey: "must-stay-on-server",
      realtimeFetch,
      importRetryIntervalMs: 60_000
    } as Parameters<typeof createServer>[0] & {
      realtimeApiKey: string;
      realtimeFetch: typeof fetch;
    });
    servers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/session",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\no=browser-offer"
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["content-type"]).toContain("application/sdp");
    expect(response.body).toBe("v=0\r\no=qwen-answer");
    expect(response.body).not.toContain("must-stay-on-server");
  });

  it("lets the browser check Realtime availability before requesting microphone access", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-realtime-status-"));
    const app = await createServer({
      repo: new StateRepository(path.join(tmp, "state.db")),
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", async () =>
        new Response("{}", { headers: { "content-type": "application/json" } })
      ),
      realtimeApiKey: "server-secret",
      importRetryIntervalMs: 60_000
    } as Parameters<typeof createServer>[0] & { realtimeApiKey: string });
    servers.push(app);

    const response = await app.inject({ method: "GET", url: "/api/realtime/session" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      model: "qwen3.5-omni-plus-realtime",
      voice: "Tina",
      session: {
        voice: "Tina",
        turn_detection: { type: "semantic_vad" }
      }
    });
    expect(response.body).not.toContain("server-secret");
  });
});
