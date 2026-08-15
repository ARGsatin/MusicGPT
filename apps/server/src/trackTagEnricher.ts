import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import OpenAI from "openai";

import type { IntrinsicMusicTagCategory, Track, TrackTagEvidence } from "@musicgpt/shared";

import { withAiProviderCompatibility } from "./aiProviderCompatibility.js";
import { getTrackKey, normalizeTrackIdentity } from "./musicCatalog.js";
import { inferTrackTags } from "./trackTags.js";

const INTRINSIC = new Set<IntrinsicMusicTagCategory>(["artist", "mood", "style", "scene"]);

interface TrackTagEnricherOptions {
  model: string;
  tagVersion: number;
  complete?: (tracks: Track[]) => Promise<unknown>;
}

interface TagCache {
  entries: Record<string, TrackTagEvidence[]>;
}

export class TrackTagEnricher {
  private cache: TagCache;

  constructor(
    private readonly cachePath: string,
    private readonly options: TrackTagEnricherOptions
  ) {
    this.cache = this.readCache();
  }

  async enrich(tracks: Track[]): Promise<Track[]> {
    const normalized = tracks.map((track) => normalizeTrackIdentity(track));
    const missing = normalized.filter((track) => !this.cache.entries[this.cacheKey(track)]);
    let completed: Record<string, unknown> = {};
    if (missing.length > 0 && this.options.complete) {
      try {
        const value = await this.options.complete(missing);
        if (isObject(value)) completed = value;
      } catch {
        completed = {};
      }
    }
    let changed = false;
    for (const track of missing) {
      const raw = completed[getTrackKey(track)];
      const aiTags = normalizeTagEvidence(raw, "ai");
      this.cache.entries[this.cacheKey(track)] = aiTags.length > 0
        ? aiTags
        : localFallbackTags(track);
      changed = true;
    }
    if (changed) this.writeCache();
    return normalized.map((track) => ({
      ...track,
      tagEvidence: this.cache.entries[this.cacheKey(track)] ?? localFallbackTags(track)
    }));
  }

  private cacheKey(track: Track): string {
    const signature = createHash("sha256")
      .update(`${track.title}|${track.artists.join("|")}|${track.album ?? ""}`)
      .digest("hex")
      .slice(0, 12);
    return `${this.options.model}@${this.options.tagVersion}:${getTrackKey(track)}:${signature}`;
  }

  private readCache(): TagCache {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as TagCache;
      return isObject(parsed.entries) ? parsed : { entries: {} };
    } catch {
      return { entries: {} };
    }
  }

  private writeCache(): void {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const temp = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(temp, this.cachePath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
        (error.code !== "EPERM" && error.code !== "EEXIST" && error.code !== "EACCES")) {
        throw error;
      }
      fs.copyFileSync(temp, this.cachePath);
      fs.rmSync(temp);
    }
  }
}

export function createAiTagCompleter(options: {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  provider: string;
}): ((tracks: Track[]) => Promise<unknown>) | undefined {
  if (!options.apiKey) return undefined;
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {})
  });
  return async (tracks) => {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: options.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "为歌曲补全固有音乐标签。只允许 artist、mood、style、scene；禁止 period、weather、routine。返回 JSON 对象，以 trackKey 为键，每个值为 [{category,value,confidence}]。confidence 为 0 到 1。"
        },
        {
          role: "user",
          content: JSON.stringify(tracks.map((track) => ({
            trackKey: getTrackKey(track),
            title: track.title,
            artists: track.artists,
            album: track.album
          })))
        }
      ]
    };
    const response = await client.chat.completions.create(
      withAiProviderCompatibility(options.provider, request)
    );
    const content = response.choices[0]?.message.content;
    return content ? JSON.parse(content) as unknown : {};
  };
}

function normalizeTagEvidence(value: unknown, source: "ai" | "platform" | "rule"): TrackTagEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TrackTagEvidence[] => {
    if (!isObject(item) || typeof item.category !== "string" || typeof item.value !== "string") return [];
    if (!INTRINSIC.has(item.category as IntrinsicMusicTagCategory)) return [];
    const confidence = Number(item.confidence);
    return [{
      category: item.category as IntrinsicMusicTagCategory,
      value: item.value.trim(),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
      source
    }];
  }).filter((tag) => tag.value.length > 0);
}

function localFallbackTags(track: Track): TrackTagEvidence[] {
  return inferTrackTags(track)
    .filter((tag): tag is typeof tag & { category: IntrinsicMusicTagCategory } =>
      INTRINSIC.has(tag.category as IntrinsicMusicTagCategory)
    )
    .map((tag) => ({ ...tag, confidence: tag.category === "artist" ? 1 : 0.55, source: "rule" }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
