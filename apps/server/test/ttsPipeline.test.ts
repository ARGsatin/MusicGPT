import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TtsPipeline } from "../src/ttsPipeline.js";

describe("TtsPipeline", () => {
  it("synthesizes chat text with the neighbor-girl voice profile and escapes SSML", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-chat-"));
    const requests: Array<{ text: string; options: Record<string, string> }> = [];
    const saveFn = vi.fn(async (text: string, filePath: string, options) => {
      requests.push({ text, options: options ?? {} });
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);

    const result = await pipeline.synthesizeText("你好呀 & <朋友>");

    expect(result.audioUrl).toMatch(/^\/tts-cache\/[a-f0-9]{40}\.mp3$/);
    expect(result.profileKey).toBe("zh-CN-XiaoxiaoNeural|+6%|+2Hz|+0%");
    expect(requests).toEqual([
      {
        text: "你好呀 &amp; &lt;朋友&gt;",
        options: {
          voice: "zh-CN-XiaoxiaoNeural",
          rate: "+6%",
          pitch: "+2Hz",
          volume: "+0%"
        }
      }
    ]);
  });

  it("keeps Xiaoxiao's voice for an English reply", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-xiaoxiao-english-"));
    const voices: string[] = [];
    const saveFn = vi.fn(async (_text: string, filePath: string, options) => {
      voices.push(options?.voice ?? "");
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(
      dir,
      "zh-CN-XiaoxiaoNeural",
      saveFn
    );

    const result = await pipeline.synthesizeText(
      "What a lovely choice. This one sounds perfect for a quiet evening."
    );

    expect(voices).toEqual(["zh-CN-XiaoxiaoNeural"]);
    expect(result.profileKey).toBe(
      "zh-CN-XiaoxiaoNeural|+6%|+2Hz|+0%"
    );
  });

  it("uses one Xiaoxiao voice for a mixed Chinese and English reply", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-code-switch-"));
    const requests: Array<{ text: string; voice: string }> = [];
    const saveFn = vi.fn(async (text: string, filePath: string, options) => {
      const voice = options?.voice ?? "";
      requests.push({ text, voice });
      fs.writeFileSync(filePath, "ONE");
    });
    const pipeline = new TtsPipeline(
      dir,
      "zh-CN-XiaoxiaoNeural",
      saveFn
    );

    const result = await pipeline.synthesizeText(
      "这首歌叫 What a Wonderful World，真的很温柔。"
    );

    expect(requests).toEqual([
      {
        text: "这首歌叫 What a Wonderful World，真的很温柔。",
        voice: "zh-CN-XiaoxiaoNeural"
      }
    ]);
    expect(result.profileKey).toBe(
      "zh-CN-XiaoxiaoNeural|+6%|+2Hz|+0%"
    );
    expect(
      fs.readFileSync(path.join(dir, path.basename(result.audioUrl!)), "utf8")
    ).toBe("ONE");
  });

  it("speaks the friendly fallback without reading technical provider diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-friendly-"));
    const spoken: string[] = [];
    const saveFn = vi.fn(async (text: string, filePath: string) => {
      spoken.push(text);
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);

    await pipeline.synthesizeText(
      "DeepSeek 还没连接好（未检测到 DEEPSEEK_API_KEY 或 OPENAI_API_KEY），我先用本地 DJ 模式陪你聊～\n好呀，我们慢慢挑首喜欢的歌～"
    );

    expect(spoken).toEqual(["好呀，我们慢慢挑首喜欢的歌～"]);
  });

  it("speaks a long reply completely in ordered segments of at most 80 characters", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-limit-"));
    const spoken: string[] = [];
    const saveFn = vi.fn(async (text: string, filePath: string) => {
      spoken.push(text);
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);
    const longReply = `${"呀".repeat(170)}。${"好".repeat(170)}！`;

    const result = await pipeline.synthesizeSegments(longReply);

    expect(result.segments.length).toBeGreaterThan(4);
    expect(result.audioUrl).toBe(result.segments[0]?.audioUrl);
    expect(result.segments.map((segment) => segment.text).join("")).toBe(longReply);
    expect(result.segments.every((segment) => [...segment.text].length <= 80)).toBe(true);
    expect(spoken.length).toBeLessThan(result.segments.length);
    expect(result.segments.map((segment) => segment.sequence)).toEqual(
      result.segments.map((_, index) => index)
    );
  });

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

  it("coalesces concurrent synthesis requests for the same speech", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-concurrent-"));
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);

    const [first, second] = await Promise.all([
      pipeline.synthesizeText("同一条语音"),
      pipeline.synthesizeText("同一条语音")
    ]);

    expect(first.audioUrl).toBe(second.audioUrl);
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

  it("does not leave a partial cache file when synthesis fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-partial-"));
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      fs.writeFileSync(filePath, "partial");
      throw new Error("tts interrupted");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn);

    const result = await pipeline.synthesizeText("不要留下 partial audio 半截音频");

    expect(result.audioUrl).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
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

  it("prunes the oldest speech files when the cache exceeds its limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-prune-"));
    let modifiedAt = Date.now() - 10_000;
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      fs.writeFileSync(filePath, "audio");
      const timestamp = new Date((modifiedAt += 1_000));
      fs.utimesSync(filePath, timestamp, timestamp);
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn, { maxFiles: 2 });

    const first = await pipeline.synthesizeText("第一条");
    await pipeline.synthesizeText("第二条");
    await pipeline.synthesizeText("第三条");

    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".mp3"))).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, path.basename(first.audioUrl!)))).toBe(false);
  });

  it("prunes speech files older than the configured maximum age", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-age-"));
    const expired = path.join(dir, "expired.mp3");
    fs.writeFileSync(expired, "old audio");
    fs.utimesSync(expired, new Date(0), new Date(0));
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      fs.writeFileSync(filePath, "new audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn, { maxAgeMs: 1_000 });

    await pipeline.synthesizeText("新语音");

    expect(fs.existsSync(expired)).toBe(false);
  });

  it("regenerates an expired cache hit instead of serving it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tts-expired-hit-"));
    const saveFn = vi.fn(async (_text: string, filePath: string) => {
      fs.writeFileSync(filePath, "audio");
    });
    const pipeline = new TtsPipeline(dir, "zh-CN-XiaoxiaoNeural", saveFn, { maxAgeMs: 1_000 });

    const first = await pipeline.synthesizeText("会过期的语音");
    const cachedFile = path.join(dir, path.basename(first.audioUrl!));
    fs.utimesSync(cachedFile, new Date(0), new Date(0));
    const second = await pipeline.synthesizeText("会过期的语音");

    expect(second.audioUrl).toBe(first.audioUrl);
    expect(saveFn).toHaveBeenCalledTimes(2);
  });
});
