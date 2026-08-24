import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type {
  IntrinsicMusicTagCategory,
  LibraryEvidence,
  PlayEvent,
  TasteDocumentStatus,
  TasteManualRules,
  TasteProfile,
  Track,
  TrackStat,
  TrackTagEvidence
} from "@musicgpt/shared";

import { getTrackKey, normalizeTrackIdentity } from "./musicCatalog.js";
import { inferTrackTags } from "./trackTags.js";

const AUTO_START = "<!-- musicgpt:auto:start -->";
const AUTO_END = "<!-- musicgpt:auto:end -->";
const INTRINSIC_CATEGORIES = new Set<IntrinsicMusicTagCategory>([
  "artist",
  "mood",
  "style",
  "scene"
]);

const EMPTY_RULES: TasteManualRules = {
  artistWeights: {},
  tagWeights: {},
  blockedArtists: [],
  blockedTags: []
};

export interface TasteRefreshInput {
  profile: TasteProfile;
  stats: TrackStat[];
  events: PlayEvent[];
  libraryEvidence?: LibraryEvidence[];
}

export class TasteDocumentManager {
  readonly tastePath: string;
  readonly libraryPath: string;
  private readonly lastValidPath: string;
  private lastValidRules: TasteManualRules = EMPTY_RULES;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingInput: TasteRefreshInput | undefined;

  constructor(private readonly stateDir: string) {
    this.tastePath = path.join(stateDir, "taste.md");
    this.libraryPath = path.join(stateDir, "library.json");
    this.lastValidPath = path.join(stateDir, ".taste-last-valid.json");
    this.lastValidRules = this.readLastValidRules();
  }

  ensureFiles(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    if (!fs.existsSync(this.tastePath)) {
      atomicWrite(this.tastePath, defaultTasteDocument());
    }
    if (!fs.existsSync(this.libraryPath)) {
      atomicWrite(this.libraryPath, `${JSON.stringify({ version: 2, generatedAt: null, recordings: [] }, null, 2)}\n`);
    }
  }

  readRules(): { rules: TasteManualRules; status: TasteDocumentStatus } {
    this.ensureFiles();
    try {
      const raw = fs.readFileSync(this.tastePath, "utf8");
      const frontmatter = extractFrontmatter(raw);
      const parsed = normalizeRules(YAML.parse(frontmatter) as unknown);
      this.lastValidRules = parsed;
      atomicWrite(this.lastValidPath, `${JSON.stringify(parsed, null, 2)}\n`);
      return {
        rules: parsed,
        status: this.status(true, parsed)
      };
    } catch (error) {
      return {
        rules: cloneRules(this.lastValidRules),
        status: this.status(false, this.lastValidRules, safeError(error))
      };
    }
  }

  schedule(input: TasteRefreshInput): void {
    this.pendingInput = input;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const pending = this.pendingInput;
      this.pendingInput = undefined;
      this.timer = undefined;
      if (pending) void this.refresh(pending);
    }, 2_000);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pendingInput;
    this.pendingInput = undefined;
    if (pending) await this.refresh(pending);
  }

  async refresh(input: TasteRefreshInput): Promise<TasteDocumentStatus> {
    this.ensureFiles();
    const parsed = this.readRules();
    const generatedAt = new Date().toISOString();
    atomicWrite(
      this.libraryPath,
      `${JSON.stringify(buildLibraryExport(input.stats, input.events, input.libraryEvidence ?? [], generatedAt), null, 2)}\n`
    );
    const current = fs.readFileSync(this.tastePath, "utf8");
    const managed = buildManagedSection(input.profile, input.stats, generatedAt);
    atomicWrite(this.tastePath, replaceManagedSection(current, managed));
    return {
      ...parsed.status,
      updatedAt: generatedAt
    };
  }

  private status(
    valid: boolean,
    rules: TasteManualRules,
    error?: string
  ): TasteDocumentStatus {
    const stat = fs.existsSync(this.tastePath) ? fs.statSync(this.tastePath) : undefined;
    return {
      path: this.tastePath,
      ...(stat ? { updatedAt: stat.mtime.toISOString() } : {}),
      valid,
      ...(error ? { error } : {}),
      manualRules: cloneRules(rules)
    };
  }

  private readLastValidRules(): TasteManualRules {
    try {
      return normalizeRules(JSON.parse(fs.readFileSync(this.lastValidPath, "utf8")));
    } catch {
      return cloneRules(EMPTY_RULES);
    }
  }
}

function buildLibraryExport(
  stats: TrackStat[],
  events: PlayEvent[],
  libraryEvidence: LibraryEvidence[],
  generatedAt: string
) {
  const eventByTrack = new Map<string, PlayEvent[]>();
  for (const event of events) {
    const key = typeof event.trackId === "number" ? `ncm:${event.trackId}` : event.trackId;
    const values = eventByTrack.get(key) ?? [];
    values.push(event);
    eventByTrack.set(key, values);
  }
  const recordings = new Map<string, {
    recordingKey: string;
    title: string;
    artists: string[];
    versions: Track[];
    tags: TrackTagEvidence[];
    evidence: Array<Record<string, unknown>>;
  }>();
  for (const stat of stats) {
    const track = normalizeTrackIdentity(stat.track);
    const recordingKey = track.recordingKey!;
    const current = recordings.get(recordingKey) ?? {
      recordingKey,
      title: track.title,
      artists: track.artists,
      versions: [],
      tags: intrinsicTagEvidence(track),
      evidence: []
    };
    current.versions.push(track);
    if (stat.likedAt) current.evidence.push({ kind: "platform_like", trackKey: getTrackKey(track), at: stat.likedAt });
    if (stat.localFavoritedAt) current.evidence.push({ kind: "local_favorite", trackKey: getTrackKey(track), at: stat.localFavoritedAt });
    if (stat.playCount > 0) current.evidence.push({ kind: "play_count", trackKey: getTrackKey(track), count: stat.playCount, at: stat.lastPlayedAt });
    for (const event of eventByTrack.get(getTrackKey(track)) ?? []) {
      current.evidence.push({ kind: event.type, trackKey: getTrackKey(track), at: event.at });
    }
    recordings.set(recordingKey, current);
  }
  for (const item of libraryEvidence) {
    const recording = recordings.get(item.recordingKey);
    if (!recording) continue;
    recording.evidence.push({
      kind: item.kind,
      trackKey: item.trackKey,
      source: item.source,
      at: item.observedAt,
      ...(item.containerId ? { containerId: item.containerId } : {}),
      ...(item.containerName ? { containerName: item.containerName } : {}),
      ...(item.playCount !== undefined ? { playCount: item.playCount } : {})
    });
  }
  return { version: 2, generatedAt, recordings: [...recordings.values()] };
}

function intrinsicTagEvidence(track: Track): TrackTagEvidence[] {
  const explicit = track.tagEvidence ?? [];
  const inferred = inferTrackTags(track)
    .filter((tag): tag is typeof tag & { category: IntrinsicMusicTagCategory } =>
      INTRINSIC_CATEGORIES.has(tag.category as IntrinsicMusicTagCategory)
    )
    .map((tag): TrackTagEvidence => ({ ...tag, source: "rule", confidence: 0.55 }));
  return [...new Map([...explicit, ...inferred].map((tag) => [`${tag.category}:${tag.value.toLowerCase()}`, tag])).values()];
}

function buildManagedSection(profile: TasteProfile, stats: TrackStat[], generatedAt: string): string {
  const sources = new Set(stats.map((stat) => normalizeTrackIdentity(stat.track).source));
  const artists = profile.topArtists.slice(0, 8).map((artist) => `- ${artist.name}: ${artist.weight.toFixed(2)}`);
  const tags = profile.preferenceTags.slice(0, 12).map((tag) => `- ${tag.category}:${tag.value}: ${tag.weight.toFixed(2)}`);
  return [
    AUTO_START,
    "## MusicGPT 自动画像",
    "",
    profile.summary,
    "",
    `- 更新时间：${generatedAt}`,
    `- 曲源：${[...sources].join("、") || "暂无"}`,
    `- 节奏偏好：${profile.pacingPreference}`,
    "",
    "### 常听艺人",
    ...(artists.length > 0 ? artists : ["- 暂无"]),
    "",
    "### 品味标签",
    ...(tags.length > 0 ? tags : ["- 暂无"]),
    AUTO_END,
    ""
  ].join("\n");
}

function replaceManagedSection(current: string, managed: string): string {
  const start = current.indexOf(AUTO_START);
  const end = current.indexOf(AUTO_END);
  if (start >= 0 && end >= start) {
    return `${current.slice(0, start)}${managed}${current.slice(end + AUTO_END.length).replace(/^\r?\n/u, "")}`;
  }
  return `${current.trimEnd()}\n\n${managed}`;
}

function defaultTasteDocument(): string {
  return [
    "---",
    "artistWeights: {}",
    "tagWeights: {}",
    "blockedArtists: []",
    "blockedTags: []",
    "---",
    "",
    "# 我的音乐品味",
    "",
    "可在 YAML 区设置艺人或标签权重（0.5–2.0），以及屏蔽规则。自动画像区由 MusicGPT 维护。",
    "",
    AUTO_START,
    "尚未生成画像。",
    AUTO_END,
    ""
  ].join("\n");
}

function extractFrontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error("taste_frontmatter_missing");
  return match[1]!;
}

function normalizeRules(value: unknown): TasteManualRules {
  const input = isObject(value) ? value : {};
  const block = isObject(input.block) ? input.block : {};
  return {
    artistWeights: normalizeWeights(input.artistWeights),
    tagWeights: normalizeWeights(input.tagWeights),
    blockedArtists: normalizeStringList(input.blockedArtists ?? block.artists),
    blockedTags: normalizeStringList(input.blockedTags ?? block.tags)
  };
}

function normalizeWeights(value: unknown): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error("taste_weights_must_be_mapping");
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    const weight = Number(raw);
    if (!Number.isFinite(weight) || weight < 0.5 || weight > 2) {
      throw new Error(`taste_weight_out_of_range:${key}`);
    }
    return [key, weight];
  }));
}

function normalizeStringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("taste_block_must_be_string_list");
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function cloneRules(value: TasteManualRules): TasteManualRules {
  return JSON.parse(JSON.stringify(value)) as TasteManualRules;
}

function atomicWrite(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, "utf8");
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) ||
      (error.code !== "EPERM" && error.code !== "EEXIST" && error.code !== "EACCES")) {
      throw error;
    }
    fs.copyFileSync(temp, filePath);
    fs.rmSync(temp);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
