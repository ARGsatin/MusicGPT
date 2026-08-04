import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { createRealtimeSession } from "../src/realtimeSession.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("Realtime speech session", () => {
  it("exchanges the browser SDP for a gpt-realtime-2.1 native audio session", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body as FormData;
      expect(body.get("sdp")).toBe("v=0\r\no=browser-offer");
      expect(JSON.parse(String(body.get("session")))).toMatchObject({
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: { turn_detection: { type: "semantic_vad" } },
          output: { voice: "marin" }
        }
      });
      return new Response("v=0\r\no=openai-answer", {
        status: 201,
        headers: { "content-type": "application/sdp" }
      });
    });

    const answer = await createRealtimeSession({
      apiKey: "server-secret",
      offerSdp: "v=0\r\no=browser-offer",
      fetchFn
    });

    expect(answer).toBe("v=0\r\no=openai-answer");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer server-secret" }
      })
    );
  });

  it("routes the Realtime SDP exchange through a configured relay base URL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response("v=0\r\no=relay-answer", {
        status: 201,
        headers: { "content-type": "application/sdp" }
      })
    );

    await createRealtimeSession({
      apiKey: "relay-secret",
      baseUrl: "https://relay.example.com/openai/v1/",
      offerSdp: "v=0\r\no=browser-offer",
      fetchFn
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://relay.example.com/openai/v1/realtime/calls",
      expect.objectContaining({
        headers: { Authorization: "Bearer relay-secret" }
      })
    );
  });

  it("exposes the SDP exchange through the app without returning the OpenAI key", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-realtime-route-"));
    const realtimeFetch = vi.fn<typeof fetch>(async () =>
      new Response("v=0\r\no=openai-answer", {
        status: 201,
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
    expect(response.body).toBe("v=0\r\no=openai-answer");
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
    expect(response.json()).toEqual({
      enabled: true,
      model: "gpt-realtime-2.1",
      voice: "marin"
    });
    expect(response.body).not.toContain("server-secret");
  });
});
