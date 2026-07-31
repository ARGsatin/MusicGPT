import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateRepository } from "../src/stateRepository.js";

describe("persistent chat memory repository", () => {
  it("creates, updates, lists, and deletes memories without touching chat history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-memory-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.addChatMessage({
      role: "user",
      text: "我喜欢爵士",
      at: "2026-07-30T08:00:00.000Z"
    });

    const created = repo.upsertChatMemory({
      category: "preference",
      content: "用户喜欢爵士乐",
      normalizedKey: "preference:喜欢爵士",
      at: "2026-07-30T08:00:01.000Z"
    });
    const updated = repo.upsertChatMemory({
      category: "preference",
      content: "用户最近更喜欢轻爵士",
      normalizedKey: "preference:喜欢爵士",
      at: "2026-07-30T08:00:02.000Z"
    });

    expect(updated.id).toBe(created.id);
    expect(repo.getChatMemories()).toEqual([
      expect.objectContaining({
        id: created.id,
        category: "preference",
        content: "用户最近更喜欢轻爵士",
        createdAt: "2026-07-30T08:00:01.000Z",
        updatedAt: "2026-07-30T08:00:02.000Z"
      })
    ]);

    repo.clearChatMessages();
    expect(repo.getRecentMessages()).toEqual([]);
    expect(repo.getChatMemories()).toHaveLength(1);
    expect(repo.deleteChatMemory(created.id)).toBe(true);
    expect(repo.getChatMemories()).toEqual([]);
  });

  it("keeps only the most recently updated memories when pruning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-memory-prune-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    for (let index = 0; index < 4; index += 1) {
      repo.upsertChatMemory({
        category: "habit",
        content: `习惯 ${index}`,
        normalizedKey: `habit:${index}`,
        at: `2026-07-30T08:00:0${index}.000Z`
      });
    }

    repo.pruneChatMemories(2);

    expect(repo.getChatMemories().map((memory) => memory.content)).toEqual([
      "习惯 3",
      "习惯 2"
    ]);
  });
});
