import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateRepository } from "../src/stateRepository.js";

describe("conversation ledger", () => {
  it("stores at most one message per role and turn while preserving voice metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-conversation-"));
    const repo = new StateRepository(path.join(dir, "state.db"));

    const first = repo.addChatMessage({
      role: "user",
      text: "播放夜曲",
      at: "2026-08-04T08:00:00.000Z",
      turnId: "turn_voice_1",
      source: "voice",
      status: "completed",
      model: "qwen3-asr-flash-realtime",
      sessionId: "session_1"
    });
    const duplicate = repo.addChatMessage({
      role: "user",
      text: "重复事件不应覆盖",
      at: "2026-08-04T08:00:01.000Z",
      turnId: "turn_voice_1",
      source: "voice",
      status: "completed",
      sessionId: "session_1"
    });

    expect(duplicate.id).toBe(first.id);
    expect(repo.getRecentMessages()).toEqual([
      expect.objectContaining({
        id: first.id,
        text: "播放夜曲",
        turnId: "turn_voice_1",
        source: "voice",
        status: "completed",
        model: "qwen3-asr-flash-realtime",
        sessionId: "session_1"
      })
    ]);
    expect(repo.getConversationRevision()).toBe(first.id);
  });

  it("caches tool results by command id and clears them with conversation history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tool-call-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const result = { action: "pause", outcome: "executed" };

    repo.saveConversationToolCall({
      commandId: "call_1",
      turnId: "turn_1",
      toolName: "run_music_command",
      request: { request: "暂停" },
      result,
      createdAt: "2026-08-04T08:00:00.000Z"
    });

    expect(repo.getConversationToolCall("call_1")).toEqual(expect.objectContaining({
      commandId: "call_1",
      turnId: "turn_1",
      request: { request: "暂停" },
      result
    }));

    const revisionBeforeClear = repo.getConversationRevision();
    repo.clearChatMessages();
    expect(repo.getConversationToolCall("call_1")).toBeUndefined();
    expect(repo.getConversationRevision()).toBeGreaterThan(revisionBeforeClear);
  });
});
