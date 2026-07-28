import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DjScript } from "@musicgpt/shared";
import { saveEdgeTts } from "./edgeTtsClient.js";

const DEFAULT_RATE = "+6%";
const DEFAULT_PITCH = "+2Hz";
const DEFAULT_VOLUME = "+0%";
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface SpeechSynthesisResult {
  audioUrl?: string;
  profileKey: string;
}

type SaveFn = (
  text: string,
  filePath: string,
  options?: { voice?: string; rate?: string; pitch?: string; volume?: string }
) => Promise<void>;

interface TtsPipelineOptions {
  maxFiles?: number;
  maxAgeMs?: number;
}

export class TtsPipeline {
  private readonly inFlight = new Map<string, Promise<SpeechSynthesisResult>>();
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly cacheDir: string,
    private voice: string,
    private readonly saveFn: SaveFn = saveEdgeTts,
    options: TtsPipelineOptions = {}
  ) {
    fs.mkdirSync(cacheDir, { recursive: true });
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  setVoice(voice: string): void {
    if (voice.trim()) {
      this.voice = voice.trim();
    }
  }

  getVoice(): string {
    return this.voice;
  }

  async synthesizeText(text: string): Promise<SpeechSynthesisResult> {
    const profileKey = `${this.voice}|${DEFAULT_RATE}|${DEFAULT_PITCH}|${DEFAULT_VOLUME}`;
    const preparedText = prepareSpeechText(text);
    if (!preparedText) {
      return { profileKey };
    }
    const key = crypto.createHash("sha1").update(`${profileKey}:${preparedText}`).digest("hex");
    const filename = `${key}.mp3`;
    const targetPath = path.resolve(this.cacheDir, filename);

    if (this.isUsableCacheFile(targetPath)) {
      return {
        audioUrl: `/tts-cache/${filename}`,
        profileKey
      };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const synthesis = (async (): Promise<SpeechSynthesisResult> => {
      const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
      try {
        await this.saveFn(escapeSsmlText(preparedText), tempPath, {
          voice: this.voice,
          rate: DEFAULT_RATE,
          pitch: DEFAULT_PITCH,
          volume: DEFAULT_VOLUME
        });
        if (fs.existsSync(targetPath)) {
          safeRemove(tempPath);
        } else {
          fs.renameSync(tempPath, targetPath);
        }
      } catch {
        safeRemove(tempPath);
        return { profileKey };
      }
      try {
        this.pruneCache();
      } catch {
        // Cache maintenance must never make an otherwise valid speech request fail.
      }
      return {
        audioUrl: `/tts-cache/${filename}`,
        profileKey
      };
    })();
    this.inFlight.set(key, synthesis);
    try {
      return await synthesis;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private isUsableCacheFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    try {
      const expired =
        this.maxAgeMs > 0 && fs.statSync(filePath).mtimeMs < Date.now() - this.maxAgeMs;
      if (!expired) {
        return true;
      }
    } catch {
      // A broken cache entry is treated as a miss and regenerated.
    }
    safeRemove(filePath);
    return false;
  }

  private pruneCache(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    const files = fs
      .readdirSync(this.cacheDir)
      .filter((name) => name.endsWith(".mp3"))
      .map((name) => {
        const filePath = path.resolve(this.cacheDir, name);
        try {
          return { filePath, modifiedAt: fs.statSync(filePath).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is { filePath: string; modifiedAt: number } => Boolean(entry));

    const retained: Array<{ filePath: string; modifiedAt: number }> = [];
    for (const file of files) {
      if (this.maxAgeMs > 0 && file.modifiedAt < cutoff) {
        safeRemove(file.filePath);
      } else {
        retained.push(file);
      }
    }

    retained.sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of retained.slice(0, Math.max(0, retained.length - this.maxFiles))) {
      safeRemove(file.filePath);
    }
  }

  async synthesize(script: DjScript): Promise<DjScript> {
    const result = await this.synthesizeText(script.text);
    if (!result.audioUrl) {
      return script;
    }
    return {
      ...script,
      audioUrl: result.audioUrl
    };
  }
}

export function prepareSpeechText(text: string): string {
  const lines = text.split(/\r?\n/);
  if (
    lines[0] &&
    /DEEPSEEK_API_KEY|OPENAI_API_KEY|刚刚开了个小差.*本地 DJ 模式/.test(lines[0])
  ) {
    lines.shift();
  }
  return lines.join(" ").replace(/\s+/g, " ").trim().slice(0, 320);
}

function escapeSsmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeRemove(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A locked cache file can be retried during the next maintenance pass.
  }
}
