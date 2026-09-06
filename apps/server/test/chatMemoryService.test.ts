import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatMemoryService } from "../src/chatMemoryService.js";
import { StateRepository } from "../src/stateRepository.js";

describe("chat memory service", () => {
  it("captures stable memories, replaces superseded facts, and skips secrets", async () => {
    const repo = createRepo();
    const old = repo.upsertChatMemory({
      category: "preference",
      content: "用户喜欢重金属",
      normalizedKey: "preference:music",
      at: "2026-07-30T08:00:00.000Z"
    });
    const updates: string[][] = [];
    const service = new ChatMemoryService(
      repo,
      async () => ({
        upserts: [
          {
            category: "preference",
            content: "用户现在更喜欢轻爵士",
            normalizedKey: "preference:music",
            supersedesIds: [old.id]
          },
          {
            category: "background",
            content: "用户的 API Key 是 secret",
            normalizedKey: "background:key"
          },
          {
            category: "background",
            content: "用户的支付宝账号是 123456",
            normalizedKey: "background:payment"
          }
        ],
        deleteIds: []
      }),
      (memories) => updates.push(memories.map((memory) => memory.content))
    );

    service.enqueueCapture("我现在更喜欢轻爵士", "这和之前不一样啦。");
    await service.waitForIdle();

    expect(service.list().map((memory) => memory.content)).toEqual([
      "用户现在更喜欢轻爵士"
    ]);
    expect(updates).toEqual([["用户现在更喜欢轻爵士"]]);
  });

  it("selects relevant memories before recent unrelated ones", () => {
    const repo = createRepo();
    repo.upsertChatMemory({
      category: "habit",
      content: "用户周末喜欢晨跑",
      normalizedKey: "habit:run",
      at: "2026-07-30T08:00:00.000Z"
    });
    repo.upsertChatMemory({
      category: "preference",
      content: "用户喜欢雨天听轻爵士",
      normalizedKey: "preference:jazz",
      at: "2026-07-30T09:00:00.000Z"
    });
    repo.upsertChatMemory({
      category: "background",
      content: "用户最近在学习法语",
      normalizedKey: "background:french",
      at: "2026-07-30T10:00:00.000Z"
    });
    const service = new ChatMemoryService(repo, undefined);

    expect(service.relevantTo("雨天听什么爵士好？")[0]?.content).toBe(
      "用户喜欢雨天听轻爵士"
    );
    expect(service.relevantTo("解释一下量子纠缠")).toEqual([]);
  });

  it("isolates extractor failures from later memory updates", async () => {
    const repo = createRepo();
    let calls = 0;
    const service = new ChatMemoryService(repo, async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("provider unavailable");
      }
      return {
        upserts: [
          {
            category: "habit",
            content: "用户睡前会听音乐",
            normalizedKey: "habit:bedtime-music"
          }
        ],
        deleteIds: []
      };
    });

    service.enqueueCapture("第一条", "第一条回复");
    service.enqueueCapture("我睡前会听音乐", "记下啦");
    await service.waitForIdle();

    expect(service.list().map((memory) => memory.content)).toEqual([
      "用户睡前会听音乐"
    ]);
  });

  it("requires an explicit request before storing other sensitive personal information", async () => {
    const repo = createRepo();
    const service = new ChatMemoryService(repo, async () => ({
      upserts: [
        {
          category: "background",
          content: "用户确诊了花粉过敏",
          normalizedKey: "background:health"
        }
      ],
      deleteIds: []
    }));

    service.enqueueCapture("我最近确诊了花粉过敏", "春天确实要多留意。");
    await service.waitForIdle();
    expect(service.list()).toEqual([]);

    service.enqueueCapture("请记住我确诊了花粉过敏", "好，我会记得。");
    await service.waitForIdle();
    expect(service.list().map((memory) => memory.content)).toEqual([
      "用户确诊了花粉过敏"
    ]);
  });

  it("does not resurrect an in-flight memory after the user clears memories", async () => {
    const repo = createRepo();
    let markStarted: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updates: string[][] = [];
    const service = new ChatMemoryService(
      repo,
      async () => {
        markStarted();
        await gate;
        return {
          upserts: [
            {
              category: "preference",
              content: "用户喜欢蓝色",
              normalizedKey: "preference:color"
            }
          ],
          deleteIds: []
        };
      },
      (memories) => updates.push(memories.map((memory) => memory.content))
    );

    service.enqueueCapture("我喜欢蓝色", "很衬你。");
    await started;
    service.clear();
    release();
    await service.waitForIdle();

    expect(service.list()).toEqual([]);
    expect(updates).toEqual([[]]);
  });
});

function createRepo(): StateRepository {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-memory-service-"));
  return new StateRepository(path.join(dir, "state.db"));
}
