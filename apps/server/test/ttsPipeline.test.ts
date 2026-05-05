import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TtsPipeline } from "../src/ttsPipeline.js";

describe("TtsPipeline", () => {
  it("writes cache on miss and reuses cache on hit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-"));
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);
    const script = {
      id: "dj1",
      text: "你好",
      reason: "test",
      trackIds: [1],
      createdAt: new Date().toISOString()
    };

    const first = await pipeline.synthesize(script);
    const second = await pipeline.synthesize(script);

    expect(first.audioUrl).toBeDefined();
    expect(second.audioUrl).toBe(first.audioUrl);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("falls back without blocking when synthesis fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-fail-"));
    const saveFn = vi.fn(async () => {
      throw new Error("tts failed");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);
    const script = {
      id: "dj2",
      text: "失败回退",
      reason: "test",
      trackIds: [1],
      createdAt: new Date().toISOString()
    };

    const result = await pipeline.synthesize(script);
    expect(result.audioUrl).toBeUndefined();
  });

  it("uses updated voice in cache key when DJ settings change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-voice-"));
    const voices: string[] = [];
    const saveFn = vi.fn(async (_text: string, filePath: string, options) => {
      voices.push(options?.voice ?? "");
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);
    const script = {
      id: "dj3",
      text: "同一句播报",
      reason: "test",
      trackIds: [1],
      createdAt: new Date().toISOString()
    };

    const first = await pipeline.synthesize(script);
    pipeline.setVoice("zh-CN-XiaoyiNeural");
    const second = await pipeline.synthesize(script);

    expect(first.audioUrl).not.toBe(second.audioUrl);
    expect(voices).toEqual(["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural"]);
  });
});
