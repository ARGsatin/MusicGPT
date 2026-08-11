import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MusicCommandModule } from "../src/musicCommand.js";
import { StateRepository } from "../src/stateRepository.js";

describe("MusicCommandModule", () => {
  it("shares one in-flight execution and caches later retries by command id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-"));
    const module = new MusicCommandModule(new StateRepository(path.join(dir, "state.db")));
    let executions = 0;
    const run = async () => {
      executions += 1;
      await Promise.resolve();
      return {
        action: "skip" as const,
        outcome: "executed" as const,
        summary: "已切歌",
        now: { queue: [], paused: false }
      };
    };
    const request = {
      turnId: "turn-1",
      commandId: "call-1",
      request: "下一首",
      mode: "voice_direct" as const
    };

    const [first, concurrent] = await Promise.all([
      module.execute(request, run),
      module.execute(request, run)
    ]);
    const later = await module.execute(request, run);

    expect(executions).toBe(1);
    expect(concurrent).toEqual(first);
    expect(later).toEqual(first);
  });

  it("allows a confirmation token to be claimed only once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-confirmation-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const module = new MusicCommandModule(repo);
    const candidate = { id: 42, title: "候选", artists: ["歌手"] };
    repo.saveConversationToolCall({
      commandId: "confirm-1",
      turnId: "turn-search",
      toolName: "run_music_command",
      request: { request: "播放候选" },
      result: {
        action: "play_specific",
        outcome: "needs_confirmation",
        summary: "选哪一首",
        now: { queue: [], paused: false },
        candidates: [candidate],
        confirmationToken: "confirm-1"
      },
      createdAt: new Date().toISOString()
    });
    let executions = 0;
    const run = async () => {
      executions += 1;
      return {
        action: "play_specific" as const,
        outcome: "executed" as const,
        summary: "已播放",
        now: { queue: [], paused: false }
      };
    };
    const base = {
      turnId: "turn-confirm",
      request: "第一首",
      mode: "voice_direct" as const,
      confirmationToken: "confirm-1",
      selectedTrackId: 42
    };

    const [first, second] = await Promise.all([
      module.execute({ ...base, commandId: "call-a" }, run),
      module.execute({ ...base, commandId: "call-b" }, run)
    ]);

    expect(executions).toBe(1);
    expect([first.outcome, second.outcome].sort()).toEqual(["executed", "failed"]);
  });
});
