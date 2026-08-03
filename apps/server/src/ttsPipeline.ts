import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChatSpeechSegment, DjScript } from "@musicgpt/shared";
import { saveEdgeTts } from "./edgeTtsClient.js";
import { SpeechTextSegmenter } from "./speechSegmenter.js";

const DEFAULT_RATE = "+6%";
const DEFAULT_PITCH = "+2Hz";
const DEFAULT_VOLUME = "+0%";
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EMOJI_SEQUENCE =
  /(?:\p{Regional_Indicator}{1,2}|[#*0-9]\uFE0F?\u20E3|\p{Emoji_Modifier}|\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?)*)(?:[\u{E0020}-\u{E007E}]*\u{E007F})?/gu;

interface SpeechSynthesisResult {
  audioUrl?: string;
  profileKey: string;
}

interface SegmentedSpeechSynthesisResult extends SpeechSynthesisResult {
  segments: ChatSpeechSegment[];
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

interface SpeechProfile {
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
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
    const preparedText = prepareSpeechText(text);
    const profile = this.getSpeechProfile();
    const profileKey = profileKeyFor(profile);
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
        await this.saveFn(escapeSsmlText(preparedText), tempPath, profile);
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

  async synthesizeSegments(text: string): Promise<SegmentedSpeechSynthesisResult> {
    const preparedText = prepareSpeechText(text);
    const profileKey = profileKeyFor(this.getSpeechProfile());
    if (!preparedText) {
      return { profileKey, segments: [] };
    }

    const segmenter = new SpeechTextSegmenter({ minSoftBreakChars: 16, maxChars: 80 });
    const texts = [...segmenter.push(preparedText), ...segmenter.finish()];
    const segments: ChatSpeechSegment[] = [];
    for (const [sequence, segmentText] of texts.entries()) {
      const speech = await this.synthesizeText(segmentText);
      if (!speech.audioUrl) {
        return { profileKey: speech.profileKey, segments: [] };
      }
      segments.push({
        sequence,
        text: segmentText,
        audioUrl: speech.audioUrl
      });
    }
    const audioUrl = segments[0]?.audioUrl;
    return audioUrl
      ? {
          profileKey,
          audioUrl,
          segments
        }
      : { profileKey, segments };
  }

  private getSpeechProfile(): SpeechProfile {
    return {
      voice: this.voice,
      rate: DEFAULT_RATE,
      pitch: DEFAULT_PITCH,
      volume: DEFAULT_VOLUME
    };
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
  if (
    /^(?:尚未连接 DeepSeek\/OpenAI，当前无法生成开放式回复。|DeepSeek 暂时没能生成可信的(?:回复，请重试。|点评；这次不使用本地套话。))$/u.test(
      text.trim()
    )
  ) {
    return "";
  }
  const lines = text.split(/\r?\n/);
  if (
    lines[0] &&
    /DEEPSEEK_API_KEY|OPENAI_API_KEY|刚刚开了个小差.*本地 DJ 模式/.test(lines[0])
  ) {
    lines.shift();
  }
  return lines
    .join(" ")
    .replace(EMOJI_SEQUENCE, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？；：、,.!?;:])/g, "$1")
    .trim();
}

function escapeSsmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function profileKeyFor(profile: SpeechProfile): string {
  return `${profile.voice}|${profile.rate}|${profile.pitch}|${profile.volume}`;
}

function safeRemove(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A locked cache file can be retried during the next maintenance pass.
  }
}
