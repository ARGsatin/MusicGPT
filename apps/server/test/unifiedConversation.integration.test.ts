import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AiDjAssistant } from "../src/aiDjAssistant.js";
import { fallbackClassify } from "../src/aiDjAssistant.js";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

describe("unified conversation API", () => {
  it("shares voice history with a later text responder without creating a second voice answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-unified-api-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.upsertTrackStats([{
      track: { id: 1, title: "Seed", artists: ["Artist"] },
      playCount: 1
    }]);
    let textContext: string[] = [];
    const assistant: AiDjAssistant = {
      status: () => ({ configured: true, provider: "test", model: "deepseek-test" }),
      classify: async (message) => fallbackClassify(message),
      selectTrack: async (_description, candidates) => ({ trackId: candidates[0]?.id }),
      commentTrack: async () => "点评",
      commentCurrent: async () => "点评",
      chat: async (_message, context) => {
        textContext = context.messages.map((message) => message.text);
        return "我记得你刚才的语音。";
      }
    };
    const app = await createServer({
      repo,
      aiDjAssistant: assistant,
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", async () => json({ code: 200, result: [] })),
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const start = await app.inject({
      method: "POST",
      url: "/api/conversation/voice/turns",
      payload: {
        sessionId: "session-1",
        clientTurnId: "item-1",
        transcript: "我想听一点爵士",
        at: "2026-08-04T09:00:00.000Z"
      }
    });
    expect(start.statusCode).toBe(200);
    const { turnId } = start.json() as { turnId: string };

    const commandPayload = {
      turnId,
      commandId: "call-pause-1",
      request: "暂停",
      mode: "voice_direct"
    };
    const firstCommand = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: commandPayload
    });
    const retriedCommand = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: commandPayload
    });
    expect(firstCommand.statusCode).toBe(200);
    expect(retriedCommand.json()).toEqual(firstCommand.json());
    expect(repo.getConversationToolCall("call-pause-1")).toBeDefined();

    const complete = await app.inject({
      method: "POST",
      url: `/api/conversation/voice/turns/${encodeURIComponent(turnId)}/complete`,
      payload: {
        transcript: "好，从轻松一点的开始。",
        model: "qwen3.5-omni-plus-realtime",
        responseId: "response-1",
        status: "completed",
        at: "2026-08-04T09:00:01.000Z"
      }
    });
    expect(complete.statusCode).toBe(200);

    const text = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { message: "还记得我刚才说什么吗", turnId: "text-1" }
    });
    expect(text.statusCode).toBe(200);
    expect(textContext).toEqual(expect.arrayContaining([
      "我想听一点爵士",
      "好，从轻松一点的开始。"
    ]));
    expect(repo.getRecentMessages()).toHaveLength(4);
    expect(repo.getRecentMessages().filter((message) => message.turnId === turnId)).toHaveLength(2);

    await app.inject({
      method: "POST",
      url: "/api/realtime/errors",
      payload: { code: "input_transcription_failed" }
    });
    const status = await app.inject({ method: "GET", url: "/api/system/status" });
    expect(status.json()).toMatchObject({
      realtimeConversationMode: "unified",
      inputTranscriptionEnabled: true,
      realtimeLastError: "input_transcription_failed"
    });
  });
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" }
  });
}
