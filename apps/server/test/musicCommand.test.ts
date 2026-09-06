import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MusicActionPlan, NowPlayingState } from "@musicgpt/shared";
import { MusicCommandModule, type MusicCommandRuntime } from "../src/musicCommand.js";
import { StateRepository } from "../src/stateRepository.js";

describe("MusicCommandModule", () => {
  it("recovers an explicit instrumental exclusion when the planner drops it", async () => {
    const now: NowPlayingState = { queue: [], paused: false };
    const receivedConstraints: unknown[] = [];
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => ({
        actions: [{ action: "play_by_description", description: "爵士", immediate: true }],
        constraints: [],
        references: [],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async (_request, _intent, _mode, constraints) => {
        receivedConstraints.push(...(constraints ?? []));
        return { action: "play_by_description", outcome: "executed", summary: "已切换。", now };
      }
    });

    const result = await module.execute({
      turnId: "explicit-avoid-instrumental",
      commandId: "explicit-avoid-instrumental",
      request: "来点爵士，但不要纯器乐",
      mode: "voice_direct"
    });

    expect(result.outcome).toBe("executed");
    expect(receivedConstraints).toContainEqual({
      kind: "avoid",
      value: "器乐",
      scope: "session",
      hard: true
    });
  });

  it("clarifies a deictic version correction when there is no current track", async () => {
    const now: NowPlayingState = { queue: [], paused: true };
    let effects = 0;
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "update_session_intent",
          description: "换一个版本",
          feedbackReason: "bad_version",
          scope: "session"
        }],
        constraints: [],
        references: [],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        effects += 1;
        return { action: "noop", outcome: "answered", summary: "不应执行", now };
      },
      handleAction: async () => {
        effects += 1;
        return { action: "update_session_intent", outcome: "executed", summary: "不应执行", now };
      }
    });

    const result = await module.execute({
      turnId: "missing-current-version",
      commandId: "missing-current-version",
      request: "不要这个版本，换一个",
      mode: "text_suggest"
    });

    expect(result).toMatchObject({
      action: "noop",
      outcome: "needs_confirmation",
      clarification: { question: expect.stringContaining("哪首歌") }
    });
    expect(effects).toBe(0);
  });

  it("executes an unambiguous undo-learning request without trusting a drifting model plan", async () => {
    const now: NowPlayingState = { queue: [], paused: false };
    const actions: string[] = [];
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => ({
        actions: [{ action: "noop" }],
        constraints: [],
        references: [],
        confidence: 1,
        clarification: { question: "你想撤销什么？" }
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "不应执行", now }),
      handleAction: async (_request, step) => {
        actions.push(step.action);
        return {
          action: step.action,
          outcome: "executed",
          summary: "已撤销刚才那条学习。",
          now,
          learningReceipt: {
            receiptId: "undo-receipt",
            scope: "long_term",
            changedSignals: [],
            replacedQueueCount: 0,
            summary: "已撤销刚才那条学习。",
            undoToken: "undo-token",
            undoExpiresAt: new Date(Date.now() + 60_000).toISOString()
          }
        };
      }
    });

    const result = await module.execute({
      turnId: "undo-learning",
      commandId: "undo-learning",
      request: "撤销刚才那条学习",
      mode: "voice_direct"
    });

    expect(actions).toEqual(["update_long_term_preference"]);
    expect(result).toMatchObject({
      action: "update_long_term_preference",
      outcome: "executed",
      learningReceipt: { receiptId: "undo-receipt" }
    });
  });

  it("plays an exact source-aware trackKey without sending it through fuzzy model search", async () => {
    const target = {
      id: 1945894789,
      trackKey: "ncm:1945894789",
      source: "ncm" as const,
      sourceId: "1945894789",
      title: "队列目标",
      artists: ["歌手"]
    };
    let now: NowPlayingState = {
      track: { id: 1, trackKey: "ncm:1", title: "当前", artists: ["歌手"] },
      queue: [{ track: target, score: 1, reason: "测试" }],
      paused: false
    };
    let plans = 0;
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => {
        plans += 1;
        return {
          actions: [{ action: "play_specific", query: "ncm:1945894789" }],
          constraints: [], references: [], confidence: 1
        };
      },
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => { throw new Error("exact trackKey must not be searched"); },
      resolveTrack: (trackId) => trackId === target.trackKey ? target : undefined,
      playTrack: async (track) => {
        now = { ...now, track, paused: false };
        return now;
      },
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "不应执行", now })
    });

    const result = await module.execute({
      turnId: "exact-track-key",
      commandId: "exact-track-key",
      request: "播放 ncm:1945894789",
      mode: "text_suggest"
    });

    expect(plans).toBe(0);
    expect(result).toMatchObject({
      action: "play_specific",
      outcome: "executed",
      now: { track: { trackKey: "ncm:1945894789" } }
    });
  });

  it("asks instead of executing when a mandatory constraint was lost by the planner", async () => {
    let effects = 0;
    const now = { queue: [], paused: false };
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now, plan: async () => ({ actions: [{ action: "skip" }], constraints: [], references: [], confidence: 1 }),
      classify: async () => ({ type: "chat" }), searchSongs: async () => [], playTrack: async () => now,
      setFavorite: async () => undefined, replay: async () => undefined,
      handleIntent: async () => { effects++; return { action: "skip", outcome: "executed", summary: "", now }; }
    });
    const result = await module.execute({ turnId: "hard-lost", commandId: "hard-lost", request: "下一首必须是女声", mode: "voice_direct" });
    expect(result.outcome).toBe("needs_confirmation");
    expect(effects).toBe(0);
  });
  it("favorites the selected song after a play step, not the pre-command current song", async () => {
    let now: NowPlayingState = { track: { id: 1, title: "Old", artists: ["Old Artist"] }, queue: [], paused: false };
    const liked: unknown[] = [];
    const target = { id: 42, title: "Target", artists: ["Artist"] };
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => ({ actions: [{ action: "play_specific", query: "Target" }, { action: "like", reference: { kind: "current" } }], constraints: [], references: [], confidence: 1 }),
      classify: async () => ({ type: "chat" }), searchSongs: async () => [target],
      playTrack: async (track) => now = { ...now, track },
      setFavorite: async (id) => { liked.push(id); }, replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "", now })
    });
    const result = await module.execute({ turnId: "new-like", commandId: "new-like", request: "播放 Target 后再收藏", mode: "voice_direct" });
    expect(result.outcome).toBe("executed");
    expect(liked).toEqual(["ncm:42"]);
  });
  it("keeps a successful play when favorite fails and never repeats it on retry", async () => {
    let now: NowPlayingState = { queue: [], paused: false };
    let plays = 0;
    const target = { id: 42, title: "Target", artists: ["Artist"] };
    const module = new MusicCommandModule(new StateRepository(":memory:"), {
      getNow: () => now,
      plan: async () => ({ actions: [{ action: "play_specific", query: "Target" }, { action: "like", reference: { kind: "track", trackId: 42 } }], constraints: [], references: [], confidence: 1 }),
      classify: async () => ({ type: "chat" }), searchSongs: async () => [target],
      playTrack: async (track) => { plays++; now = { ...now, track }; return now; },
      setFavorite: async () => { throw new Error("private adapter detail"); }, replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "", now })
    });
    const request = { turnId: "failure", commandId: "once", request: "播放 Target 然后收藏", mode: "voice_direct" as const };
    const result = await module.execute(request);
    expect(result).toMatchObject({ outcome: "failed", now: { track: target }, actions: [
      { index: 0, action: "play_specific", outcome: "executed" }, { index: 1, action: "like", outcome: "failed" }
    ] });
    expect(result.summary).not.toContain("private adapter");
    expect(await module.execute(request)).toEqual(result);
    expect(plays).toBe(1);
  });
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

  it("scopes command idempotency to the turn id and command id pair", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-pair-"));
    const module = new MusicCommandModule(new StateRepository(path.join(dir, "state.db")));
    let executions = 0;
    const run = async () => {
      executions += 1;
      return {
        action: "pause" as const,
        outcome: "executed" as const,
        summary: `执行-${executions}`,
        now: { queue: [], paused: true }
      };
    };
    const base = {
      commandId: "reused-call-id",
      request: "暂停",
      mode: "voice_direct" as const
    };

    const firstTurn = await module.execute({ ...base, turnId: "turn-a" }, run);
    const secondTurn = await module.execute({ ...base, turnId: "turn-b" }, run);
    const secondRetry = await module.execute({ ...base, turnId: "turn-b" }, run);

    expect(executions).toBe(2);
    expect(firstTurn.summary).toBe("执行-1");
    expect(secondTurn.summary).toBe("执行-2");
    expect(secondRetry).toEqual(secondTurn);
  });

  it("clarifies a low-confidence plan before performing any side effect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-confidence-"));
    const now: NowPlayingState = {
      track: { id: "qq:current", trackKey: "qq:current", title: "当前", artists: ["歌手"] },
      queue: [],
      paused: false
    };
    let favoriteChanges = 0;
    const plan: MusicActionPlan = {
      actions: [{ action: "like", reference: { kind: "current" }, confidence: 0.6 }],
      constraints: [],
      references: [{ kind: "current" }],
      confidence: 0.6
    };
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => plan,
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => {
        favoriteChanges += 1;
      },
      replay: async () => undefined,
      handleIntent: async () => ({
        action: "noop",
        outcome: "answered",
        summary: "不应执行",
        now
      })
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-low-confidence",
      commandId: "call-low-confidence",
      request: "帮我处理一下这首",
      mode: "voice_direct"
    });

    expect(result).toMatchObject({
      action: "noop",
      outcome: "needs_confirmation",
      clarification: { question: expect.stringContaining("确认") }
    });
    expect(favoriteChanges).toBe(0);
  });

  it("returns the learning receipt from a deterministic favorite command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-favorite-receipt-"));
    const now: NowPlayingState = {
      track: { id: "qq:current", trackKey: "qq:current", title: "当前", artists: ["歌手"] },
      queue: [],
      paused: false
    };
    const learningReceipt = {
      receiptId: "receipt-favorite",
      scope: "long_term" as const,
      changedSignals: [{
        signalId: "signal-favorite",
        dimension: "recording" as const,
        key: "recording:current",
        label: "你明确收藏了这首录音",
        operation: "added" as const,
        weight: 0.8,
        source: "explicit" as const
      }],
      replacedQueueCount: 2,
      summary: "你明确收藏了这首录音",
      undoToken: "undo-favorite",
      undoExpiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => learningReceipt,
      replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "不应执行", now })
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-favorite-receipt",
      commandId: "call-favorite-receipt",
      request: "收藏这首",
      mode: "text_suggest"
    });

    expect(result).toMatchObject({
      action: "like",
      outcome: "executed",
      learningReceipt: { receiptId: "receipt-favorite", replacedQueueCount: 2 }
    });
  });

  it("reports a step result for deterministic shortcut commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-shortcut-actions-"));
    const now: NowPlayingState = {
      track: { id: 9, title: "Bloom", artists: ["Dabin"] },
      queue: [],
      paused: false
    };
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "不应执行", now })
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-shortcut-actions",
      commandId: "call-shortcut-actions",
      request: "现在是什么歌",
      mode: "text_suggest"
    });

    expect(result.actions).toEqual([{
      index: 0,
      action: "query_current",
      outcome: "answered",
      summary: "现在是《Bloom》— Dabin。",
      now
    }]);
  });

  it("executes a compound action plan in order and reports every completed step", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-compound-"));
    let now: NowPlayingState = { queue: [], paused: false };
    const executed: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [
          { action: "pause", confidence: 1 },
          {
            action: "play_by_description",
            description: "适合工作的歌",
            searchQuery: "专注 工作",
            immediate: true,
            confidence: 0.94
          }
        ],
        constraints: [{ kind: "scene", value: "work" }],
        references: [],
        confidence: 0.94
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async (_request, intent) => {
        executed.push(intent.type);
        if (intent.type === "pause") {
          now = { ...now, paused: true };
          return { action: "pause", outcome: "executed", summary: "已暂停。", now };
        }
        now = {
          track: { id: 7, title: "工作歌", artists: ["歌手"] },
          queue: [],
          paused: false
        };
        return {
          action: "play_by_description",
          outcome: "executed",
          summary: "已切到工作歌。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-compound",
      commandId: "call-compound",
      request: "暂停后换一首适合工作的歌",
      mode: "voice_direct"
    });

    expect(executed).toEqual(["pause", "play_by_description"]);
    expect(result).toMatchObject({
      action: "play_by_description",
      outcome: "executed",
      now: { track: { title: "工作歌" } },
      actions: [
        { index: 0, action: "pause", outcome: "executed" },
        { index: 1, action: "play_by_description", outcome: "executed" }
      ]
    });
  });

  it("does not let a favorite shortcut truncate a compound request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-like-then-play-"));
    let now: NowPlayingState = {
      track: {
        id: "qq:current",
        trackKey: "qq:current",
        title: "当前歌曲",
        artists: ["当前歌手"]
      },
      queue: [],
      paused: false
    };
    const effects: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [
          { action: "like", reference: { kind: "current" }, confidence: 1 },
          {
            action: "play_by_description",
            description: "和当前歌曲相似但更安静",
            immediate: true,
            confidence: 0.95
          }
        ],
        constraints: [{ kind: "mood", value: "calm" }],
        references: [{ kind: "current" }],
        confidence: 0.95
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async (trackId, favorite) => {
        effects.push(`favorite:${String(trackId)}:${favorite}`);
      },
      replay: async () => undefined,
      handleIntent: async (_request, intent) => {
        effects.push(intent.type);
        now = {
          track: { id: 9, title: "安静相似曲", artists: ["新歌手"] },
          queue: [],
          paused: false
        };
        return {
          action: "play_by_description",
          outcome: "executed",
          summary: "已切到更安静的相似歌曲。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-like-then-play",
      commandId: "call-like-then-play",
      request: "收藏这首，然后换首相似但安静点的",
      mode: "voice_direct"
    });

    expect(effects).toEqual(["favorite:qq:current:true", "play_by_description"]);
    expect(result.actions?.map((action) => action.action)).toEqual([
      "like",
      "play_by_description"
    ]);
    expect(result.now.track?.title).toBe("安静相似曲");
  });

  it("executes deterministic compound controls when structured AI planning is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-fallback-compound-"));
    let now: NowPlayingState = { queue: [], paused: false };
    const effects: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      classify: async (request) => request === "暂停"
        ? { type: "pause" }
        : { type: "resume" },
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async (_request, intent) => {
        effects.push(intent.type);
        now = { ...now, paused: intent.type === "pause" };
        return {
          action: intent.type === "pause" ? "pause" : "resume",
          outcome: "executed",
          summary: intent.type === "pause" ? "已暂停。" : "已继续。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-fallback-compound",
      commandId: "call-fallback-compound",
      request: "暂停后继续播放",
      mode: "voice_direct"
    });

    expect(effects).toEqual(["pause", "resume"]);
    expect(result.actions?.map((action) => action.action)).toEqual(["pause", "resume"]);
    expect(result.now.paused).toBe(false);
  });

  it("falls back to deterministic compound controls when structured planning throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-plan-error-"));
    const now: NowPlayingState = { queue: [], paused: false };
    const effects: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => {
        throw new Error("provider timeout");
      },
      classify: async (request) => request === "暂停"
        ? { type: "pause" }
        : { type: "resume" },
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async (_request, intent) => {
        effects.push(intent.type);
        return {
          action: intent.type === "pause" ? "pause" : "resume",
          outcome: "executed",
          summary: "已执行。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-plan-error",
      commandId: "call-plan-error",
      request: "暂停后继续播放",
      mode: "voice_direct"
    });

    expect(effects).toEqual(["pause", "resume"]);
    expect(result.outcome).toBe("executed");
  });

  it("preflights an ambiguous song search before earlier compound side effects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-preflight-search-"));
    const now: NowPlayingState = {
      track: { id: 1, title: "当前", artists: ["歌手"] },
      queue: [],
      paused: false
    };
    let favoriteChanges = 0;
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [
          { action: "like", reference: { kind: "current" }, confidence: 1 },
          { action: "play_specific", query: "后来", searchQuery: "后来", confidence: 0.9 }
        ],
        constraints: [],
        references: [{ kind: "current" }],
        confidence: 0.9
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [
        { id: 11, title: "后来", artists: ["刘若英"] },
        { id: "qq:cover", trackKey: "qq:cover", title: "后来", artists: ["翻唱歌手"] }
      ],
      playTrack: async () => now,
      setFavorite: async () => {
        favoriteChanges += 1;
      },
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("ambiguous search must not reach execution");
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-ambiguous-compound",
      commandId: "call-ambiguous-compound",
      request: "收藏这首，然后播放后来",
      mode: "voice_direct"
    });

    expect(favoriteChanges).toBe(0);
    expect(result).toMatchObject({
      action: "play_specific",
      outcome: "needs_confirmation",
      candidates: [
        { id: 11, title: "后来" },
        { id: "qq:cover", title: "后来" }
      ],
      clarification: { question: expect.stringContaining("哪一首") }
    });
  });

  it.each(["不要收藏这首", "不要重播这首", "只聊聊这首，不要切歌"])(
    "treats a negated shortcut as a safety no-op: %s",
    async (request) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-safety-noop-"));
      const now: NowPlayingState = {
        track: { id: 1, title: "当前", artists: ["歌手"] },
        queue: [],
        paused: false
      };
      const effects: string[] = [];
      const module = new MusicCommandModule(
        new StateRepository(path.join(dir, "state.db")),
        {
          getNow: () => now,
          plan: async () => { throw new Error("safety no-op must not require a model"); },
          classify: async () => ({ type: "chat" }),
          searchSongs: async () => [],
          playTrack: async () => { effects.push("play"); return now; },
          setFavorite: async () => { effects.push("favorite"); },
          replay: async () => { effects.push("replay"); },
          handleIntent: async () => ({ action: "noop", outcome: "answered", summary: "聊天", now })
        }
      );

      const result = await module.execute({
        turnId: `safe-${request}`,
        commandId: `safe-${request}`,
        request,
        mode: "text_suggest"
      });

      expect(result).toMatchObject({ action: "noop", outcome: "answered" });
      expect(effects).toEqual([]);
    }
  );

  it("resumes the original compound plan after an ambiguous QQ candidate is confirmed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-resume-plan-"));
    let now: NowPlayingState = {
      track: { id: 1, title: "当前", artists: ["歌手"] },
      queue: [],
      paused: false
    };
    const effects: string[] = [];
    const plan: MusicActionPlan = {
      actions: [
        { action: "like", reference: { kind: "current" }, confidence: 1 },
        { action: "play_specific", query: "后来", searchQuery: "后来", confidence: 0.9 }
      ],
      constraints: [],
      references: [{ kind: "current" }],
      confidence: 0.9
    };
    const candidates = [
      { id: 11, title: "后来", artists: ["刘若英"] },
      {
        id: "qq:cover",
        trackKey: "qq:cover",
        title: "后来",
        artists: ["翻唱歌手"]
      }
    ];
    let planCalls = 0;
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => {
        planCalls += 1;
        if (planCalls > 1) throw new Error("confirmation must reuse the accepted plan");
        return plan;
      },
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => candidates,
      playTrack: async (track) => {
        effects.push(`play:${String(track.id)}`);
        now = { track, queue: [], paused: false };
        return now;
      },
      setFavorite: async (trackId) => {
        effects.push(`favorite:${String(trackId)}`);
      },
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("confirmed plan uses direct resolved playback");
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );
    const first = await module.execute({
      turnId: "turn-resume-plan",
      commandId: "call-resume-plan",
      request: "收藏这首，然后播放后来",
      mode: "voice_direct"
    });

    const confirmed = await module.execute({
      turnId: "turn-resume-plan-confirmation",
      commandId: "call-resume-plan-confirmation",
      request: "第二首",
      mode: "voice_direct",
      confirmationToken: first.confirmationToken!,
      selectedTrackId: "qq:cover"
    });

    expect(effects).toEqual(["favorite:ncm:1", "play:qq:cover"]);
    expect(confirmed.actions?.map((action) => action.action)).toEqual([
      "like",
      "play_specific"
    ]);
    expect(confirmed.now.track?.id).toBe("qq:cover");
    expect(planCalls).toBe(1);

    const aliasRetry = await module.execute({
      turnId: "turn-resume-plan-alias-retry",
      commandId: "call-resume-plan-alias-retry",
      request: "第一首",
      mode: "voice_direct",
      confirmationToken: "call-resume-plan",
      selectedTrackId: 11
    });

    expect(aliasRetry.outcome).toBe("failed");
    expect(effects).toEqual(["favorite:ncm:1", "play:qq:cover"]);
  });

  it("answers a queue query from a structured plan without invoking a playback intent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-query-queue-"));
    const now: NowPlayingState = {
      queue: [
        { track: { id: 2, title: "第二首", artists: ["甲"] }, score: 1, reason: "测试" },
        { track: { id: 3, title: "第三首", artists: ["乙"] }, score: 1, reason: "测试" }
      ],
      paused: false
    };
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{ action: "query_queue", confidence: 1 }],
        constraints: [],
        references: [],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("queue queries are answered inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-query-queue",
      commandId: "call-query-queue",
      request: "念一下候播清单",
      mode: "voice_direct"
    });

    expect(result).toMatchObject({
      action: "query_queue",
      outcome: "answered",
      actions: [{ index: 0, action: "query_queue", outcome: "answered" }]
    });
    expect(result.summary).toContain("《第二首》");
    expect(result.summary).toContain("《第三首》");
  });

  it("resolves a one-based recent-track reference before replaying it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-recent-reference-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.addPlayEvent({ type: "play", trackId: 101, at: "2026-08-25T08:00:00.000Z" });
    repo.addPlayEvent({ type: "play", trackId: 102, at: "2026-08-25T08:01:00.000Z" });
    const replayed: Array<string | number> = [];
    const now: NowPlayingState = { track: { id: 999, title: "当前歌曲", artists: ["甲"] }, queue: [], paused: false };
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [
          { action: "replay", reference: { kind: "recent", index: 2 }, confidence: 1 }
        ],
        constraints: [],
        references: [{ kind: "recent", index: 2 }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async (trackId) => {
        replayed.push(trackId);
      },
      handleIntent: async () => {
        throw new Error("replay references are resolved inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(repo, runtime);

    const result = await module.execute({
      turnId: "turn-recent-reference",
      commandId: "call-recent-reference",
      request: "重播刚才第二首",
      mode: "voice_direct"
    });

    expect(replayed).toEqual(["ncm:101"]);
    expect(result).toMatchObject({ action: "replay", outcome: "executed" });
  });

  it("plays a one-based recent-track reference without turning it into search text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-play-recent-reference-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.addPlayEvent({ type: "play", trackId: "ncm:recent-one", at: "2026-08-25T08:00:00.000Z" });
    repo.addPlayEvent({ type: "play", trackId: "ncm:recent-two", at: "2026-08-25T08:01:00.000Z" });
    const recentOne = { id: "ncm:recent-one", title: "最近第一首", artists: ["甲"] };
    const recentTwo = { id: "ncm:recent-two", title: "最近第二首", artists: ["乙"] };
    let now: NowPlayingState = { queue: [], paused: false };
    const searches: string[] = [];
    const played: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "play_specific",
          query: "刚才第二首",
          searchQuery: "刚才第二首",
          reference: { kind: "recent", index: 2 },
          confidence: 1
        }],
        constraints: [],
        references: [{ kind: "recent", index: 2 }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async (query) => {
        searches.push(query);
        return [];
      },
      resolveTrack: (trackId) => trackId === "ncm:recent-one" ? recentOne : recentTwo,
      playTrack: async (track) => {
        played.push(String(track.id));
        now = { track, queue: [], paused: false };
        return now;
      },
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("referenced playback is resolved inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(repo, runtime);

    const result = await module.execute({
      turnId: "turn-play-recent-reference",
      commandId: "call-play-recent-reference",
      request: "就刚才第二首",
      mode: "voice_direct"
    });

    expect(searches).toEqual([]);
    expect(played).toEqual(["ncm:recent-one"]);
    expect(result).toMatchObject({
      action: "play_specific",
      outcome: "executed",
      now: { track: { id: "ncm:recent-one" } }
    });
  });

  it("ignores playback-error events when resolving recent-track positions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-recent-play-events-only-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.addPlayEvent({ type: "play_start", trackId: "ncm:played-one", at: "2026-08-25T08:00:00.000Z" });
    repo.addPlayEvent({ type: "play", trackId: "ncm:played-two", at: "2026-08-25T08:01:00.000Z" });
    repo.addPlayEvent({ type: "playback_error", trackId: "qq:broken", at: "2026-08-25T08:02:00.000Z" });
    const tracks = new Map([
      ["ncm:played-one", { id: "ncm:played-one", title: "播过一", artists: ["甲"] }],
      ["ncm:played-two", { id: "ncm:played-two", title: "播过二", artists: ["乙"] }],
      ["qq:broken", { id: "qq:broken", title: "错误版本", artists: ["丙"] }]
    ]);
    let now: NowPlayingState = { queue: [], paused: false };
    const played: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "play_specific",
          reference: { kind: "recent", index: 1 },
          confidence: 1
        }],
        constraints: [],
        references: [{ kind: "recent", index: 1 }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      resolveTrack: (trackId) => tracks.get(String(trackId)),
      playTrack: async (track) => {
        played.push(String(track.id));
        now = { track, queue: [], paused: false };
        return now;
      },
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("referenced playback is resolved inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(repo, runtime);

    const result = await module.execute({
      turnId: "turn-recent-play-events-only",
      commandId: "call-recent-play-events-only",
      request: "放刚才那首",
      mode: "voice_direct"
    });

    expect(played).toEqual(["ncm:played-two"]);
    expect(result.now.track?.id).toBe("ncm:played-two");
  });

  it("plays the third queued track from a direct queue reference", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-play-queue-reference-"));
    const queuedTracks = [
      { id: "ncm:queue-one", title: "队列第一首", artists: ["甲"] },
      { id: "ncm:queue-two", title: "队列第二首", artists: ["乙"] },
      { id: "ncm:queue-three", title: "队列第三首", artists: ["丙"] }
    ];
    let now: NowPlayingState = {
      queue: queuedTracks.map((track) => ({ track, score: 1, reason: "测试" })),
      paused: false
    };
    const played: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "play_specific",
          reference: { kind: "queue", index: 3 },
          confidence: 1
        }],
        constraints: [],
        references: [{ kind: "queue", index: 3 }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => {
        throw new Error("queue references must not enter catalog search");
      },
      resolveTrack: (trackId) => queuedTracks.find((track) => track.id === trackId),
      playTrack: async (track) => {
        played.push(String(track.id));
        now = { track, queue: now.queue, paused: false };
        return now;
      },
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("referenced playback is resolved inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-play-queue-reference",
      commandId: "call-play-queue-reference",
      request: "后面第三首换到现在",
      mode: "text_suggest"
    });

    expect(played).toEqual(["ncm:queue-three"]);
    expect(result).toMatchObject({
      action: "play_specific",
      outcome: "executed",
      now: { track: { id: "ncm:queue-three" } }
    });
  });

  it("clarifies an unresolved playback reference before earlier compound side effects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-missing-play-reference-"));
    const now: NowPlayingState = {
      track: { id: "ncm:current", title: "当前歌曲", artists: ["甲"] },
      queue: [],
      paused: false
    };
    const effects: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [
          { action: "like", reference: { kind: "current" }, confidence: 1 },
          {
            action: "play_specific",
            reference: { kind: "recent", index: 2 },
            confidence: 1
          }
        ],
        constraints: [],
        references: [{ kind: "current" }, { kind: "recent", index: 2 }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => {
        effects.push("search");
        return [];
      },
      resolveTrack: () => undefined,
      playTrack: async () => {
        effects.push("play");
        return now;
      },
      setFavorite: async () => {
        effects.push("favorite");
      },
      replay: async () => {
        effects.push("replay");
      },
      handleIntent: async () => {
        effects.push("intent");
        return { action: "noop", outcome: "answered", summary: "不应执行", now };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-missing-play-reference",
      commandId: "call-missing-play-reference",
      request: "收藏这首，然后播放刚才第二首",
      mode: "voice_direct"
    });

    expect(result).toMatchObject({
      action: "noop",
      outcome: "needs_confirmation",
      clarification: { question: expect.stringContaining("第 2 首") }
    });
    expect(effects).toEqual([]);
  });

  it("plays a QQ track reference without coercing its trackKey to a number", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-play-qq-reference-"));
    const qqTrack = {
      id: "0039MnYb0qxYhV",
      trackKey: "qq:0039MnYb0qxYhV",
      source: "qq" as const,
      sourceId: "0039MnYb0qxYhV",
      title: "QQ 候选",
      artists: ["歌手"]
    };
    let now: NowPlayingState = { queue: [], paused: false };
    const resolved: Array<string | number> = [];
    const played: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "play_specific",
          query: "qq:0039MnYb0qxYhV",
          reference: { kind: "track", trackId: "qq:0039MnYb0qxYhV" },
          confidence: 1
        }],
        constraints: [],
        references: [{ kind: "track", trackId: "qq:0039MnYb0qxYhV" }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => {
        throw new Error("explicit track references must not enter catalog search");
      },
      resolveTrack: (trackId) => {
        resolved.push(trackId);
        return trackId === qqTrack.trackKey ? qqTrack : undefined;
      },
      playTrack: async (track) => {
        played.push(track.trackKey ?? String(track.id));
        now = { track, queue: [], paused: false };
        return now;
      },
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("referenced playback is resolved inside MusicCommand");
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-play-qq-reference",
      commandId: "call-play-qq-reference",
      request: "播放 qq:0039MnYb0qxYhV",
      mode: "text_suggest"
    });

    expect(resolved).toEqual(["qq:0039MnYb0qxYhV"]);
    expect(played).toEqual(["qq:0039MnYb0qxYhV"]);
    expect(result).toMatchObject({
      action: "play_specific",
      outcome: "executed",
      now: { track: { trackKey: "qq:0039MnYb0qxYhV" } }
    });
  });

  it("forwards a structured session-intent update without collapsing it into legacy replan", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-session-intent-"));
    const now: NowPlayingState = { queue: [], paused: false };
    const forwarded: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "update_session_intent",
          description: "接下来安静一点",
          desiredMood: "calm",
          immediate: false,
          scope: "session",
          confidence: 0.96
        }],
        constraints: [{ kind: "mood", value: "calm", scope: "session" }],
        references: [],
        confidence: 0.96
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => undefined,
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("session intent must not use legacy replan");
      },
      handleAction: async (_request, step) => {
        forwarded.push(`${step.action}:${step.desiredMood}:${step.immediate}:${step.scope}`);
        return {
          action: step.action,
          outcome: "executed",
          summary: "接下来会安静一点，当前歌曲保持不变。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-session-intent",
      commandId: "call-session-intent",
      request: "接下来安静点",
      mode: "voice_direct"
    });

    expect(forwarded).toEqual(["update_session_intent:calm:false:session"]);
    expect(result).toMatchObject({
      action: "update_session_intent",
      outcome: "executed"
    });
    expect(result.now).toEqual(now);
  });

  it("routes a fallback replan through the structured action handler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-fallback-replan-"));
    const now: NowPlayingState = { queue: [], paused: false };
    const effects: string[] = [];
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      {
        getNow: () => now,
        classify: async () => ({ type: "replan", desiredMood: "calm" }),
        searchSongs: async () => [],
        playTrack: async () => now,
        setFavorite: async () => undefined,
        replay: async () => undefined,
        handleIntent: async () => {
          effects.push("legacy-intent");
          return { action: "replan", outcome: "executed", summary: "legacy", now };
        },
        handleAction: async (_request, step) => {
          effects.push(`structured:${step.action}:${step.desiredMood}`);
          return { action: step.action, outcome: "executed", summary: "structured", now };
        }
      }
    );

    const result = await module.execute({
      turnId: "turn-fallback-replan",
      commandId: "call-fallback-replan",
      request: "接下来安静点",
      mode: "text_suggest"
    });

    expect(effects).toEqual(["structured:replan:calm"]);
    expect(result.summary).toBe("structured");
  });

  it("routes an explicit dislike to structured learning instead of treating it as cancel favorite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-command-dislike-learning-"));
    const now: NowPlayingState = {
      track: { id: 4, title: "不喜欢的歌", artists: ["歌手"] },
      queue: [],
      paused: false
    };
    let favoriteChanges = 0;
    const learned: string[] = [];
    const runtime: MusicCommandRuntime = {
      getNow: () => now,
      plan: async () => ({
        actions: [{
          action: "unlike",
          reference: { kind: "current" },
          feedbackReason: "dislike_track",
          scope: "long_term",
          confidence: 1
        }],
        constraints: [],
        references: [{ kind: "current" }],
        confidence: 1
      }),
      classify: async () => ({ type: "chat" }),
      searchSongs: async () => [],
      playTrack: async () => now,
      setFavorite: async () => {
        favoriteChanges += 1;
      },
      replay: async () => undefined,
      handleIntent: async () => {
        throw new Error("explicit dislike uses structured learning");
      },
      handleAction: async (_request, step) => {
        learned.push(`${step.feedbackReason}:${step.scope}`);
        return {
          action: "unlike",
          outcome: "executed",
          summary: "知道了，以后会少放这首。",
          now
        };
      }
    };
    const module = new MusicCommandModule(
      new StateRepository(path.join(dir, "state.db")),
      runtime
    );

    const result = await module.execute({
      turnId: "turn-dislike-learning",
      commandId: "call-dislike-learning",
      request: "不喜欢这首",
      mode: "voice_direct"
    });

    expect(favoriteChanges).toBe(0);
    expect(learned).toEqual(["dislike_track:long_term"]);
    expect(result.summary).toContain("以后会少放");
  });

  it("allows a confirmation token to be claimed only once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-confirmation-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const module = new MusicCommandModule(repo);
    const candidate = {
      // Provider adapters may keep the raw source id in `id`; confirmation
      // must use the source-aware trackKey instead of assuming NCM.
      id: "003abc",
      trackKey: "qq:003abc",
      title: "候选",
      artists: ["歌手"]
    };
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
      selectedTrackId: "qq:003abc"
    };

    const [first, second] = await Promise.all([
      module.execute({ ...base, commandId: "call-a" }, run),
      module.execute({ ...base, commandId: "call-b" }, run)
    ]);

    expect(executions).toBe(1);
    expect([first.outcome, second.outcome].sort()).toEqual(["executed", "failed"]);
  });
});
