import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { NowPlayingState } from "@musicgpt/shared";
import type { AiDjAssistant } from "../src/aiDjAssistant.js";
import { ConversationKernel } from "../src/conversationKernel.js";
import { StateRepository } from "../src/stateRepository.js";
import { WsHub } from "../src/wsHub.js";

const emptyNow: NowPlayingState = { queue: [], paused: false };

function createKernel(extractMemories?: AiDjAssistant["extractMemories"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-kernel-"));
  const repo = new StateRepository(path.join(dir, "state.db"));
  const assistant = { extractMemories } as Pick<AiDjAssistant, "extractMemories">;
  return { kernel: new ConversationKernel(repo, assistant, new WsHub(), 20), repo };
}

describe("ConversationKernel", () => {
  it("does not execute a retried text turn twice", async () => {
    const { kernel } = createKernel();
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { action: "noop" as const, reply: "只保存一次", now: emptyNow };
    };

    await kernel.respondText({ message: "你好", turnId: "text-1", now: emptyNow }, execute);
    const duplicate = await kernel.respondText(
      { message: "你好", turnId: "text-1", now: emptyNow },
      execute
    );

    expect(executions).toBe(1);
    expect(duplicate.reply).toBe("只保存一次");
    expect(kernel.getHistory().messages).toHaveLength(2);
  });

  it("persists one canonical voice turn and makes it available to later text context", async () => {
    const { kernel } = createKernel();

    const started = kernel.startVoiceTurn({
      sessionId: "session_1",
      clientTurnId: "item_1",
      transcript: "我刚才说想听爵士",
      at: "2026-08-04T09:00:00.000Z"
    });
    const duplicate = kernel.startVoiceTurn({
      sessionId: "session_1",
      clientTurnId: "item_1",
      transcript: "重复",
      at: "2026-08-04T09:00:01.000Z"
    });
    await kernel.completeVoiceTurn(started.turnId, {
      transcript: "那就从一首轻松的开始。",
      model: "qwen3.5-omni-plus-realtime",
      responseId: "response_1",
      status: "completed",
      at: "2026-08-04T09:00:02.000Z"
    });

    expect(duplicate.turnId).toBe(started.turnId);
    expect(kernel.getHistory().messages).toEqual([
      expect.objectContaining({ role: "user", source: "voice", turnId: started.turnId }),
      expect.objectContaining({ role: "assistant", source: "voice", turnId: started.turnId })
    ]);
    expect(kernel.recentContextMessages(20).map((message) => message.text)).toEqual([
      "我刚才说想听爵士",
      "那就从一首轻松的开始。"
    ]);
  });

  it("keeps interrupted speech visible but excludes it from context and memory extraction", async () => {
    const captures: string[] = [];
    const { kernel } = createKernel(async (userMessage, assistantReply) => {
      captures.push(`${userMessage}|${assistantReply}`);
      return { upserts: [], deleteIds: [] };
    });
    const started = kernel.startVoiceTurn({
      sessionId: "session_2",
      clientTurnId: "item_2",
      transcript: "继续说",
      at: "2026-08-04T09:01:00.000Z"
    });

    await kernel.completeVoiceTurn(started.turnId, {
      transcript: "这段话还没有说完",
      model: "qwen3.5-omni-plus-realtime",
      responseId: "response_2",
      status: "interrupted",
      at: "2026-08-04T09:01:01.000Z"
    });
    await kernel.waitForIdle();

    expect(kernel.getHistory().messages.at(-1)).toEqual(expect.objectContaining({
      status: "interrupted",
      text: "这段话还没有说完"
    }));
    expect(kernel.recentContextMessages(20).map((message) => message.text)).toEqual(["继续说"]);
    expect(captures).toEqual([]);
  });
});
