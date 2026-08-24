import fs from "node:fs";
import path from "node:path";

import type { MusicTag, RoutineBlock, RoutineDocumentStatus, RoutineEnergy } from "@musicgpt/shared";

export interface RoutineProvider {
  getBlocks(date: string, timezone: string): RoutineBlock[];
  status?(): RoutineDocumentStatus;
}

interface RoutineFileBlock {
  start: string;
  end: string;
  activity: string;
  expectedTags?: unknown;
  energy: RoutineEnergy;
  musicAllowed: boolean;
}

interface RoutineFile {
  timezone: string;
  weekly: Record<string, RoutineFileBlock[]>;
  overrides: Record<string, RoutineFileBlock[]>;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export class LocalRoutineProvider implements RoutineProvider {
  private lastValid: RoutineFile;
  private readonly lastValidPath: string;
  private documentStatus: RoutineDocumentStatus;

  constructor(readonly filePath: string) {
    this.lastValidPath = path.join(path.dirname(filePath), ".routine-last-valid.json");
    this.lastValid = this.readLastValid();
    this.documentStatus = { path: filePath, valid: true, timezone: "Asia/Shanghai" };
    this.ensureFile();
  }

  getBlocks(date: string, timezone: string): RoutineBlock[] {
    const config = this.readConfig();
    const day = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
    const blocks = Object.hasOwn(config.overrides, date)
      ? config.overrides[date] ?? []
      : config.weekly[day] ?? [];
    this.documentStatus.timezone = config.timezone || timezone;
    return blocks.map((block) => ({
      start: block.start,
      end: block.end,
      activity: block.activity,
      tags: normalizeExpectedTags(block.expectedTags),
      energy: block.energy,
      musicAllowed: block.musicAllowed
    }));
  }

  status(): RoutineDocumentStatus {
    return { ...this.documentStatus };
  }

  private ensureFile(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      atomicWrite(
        this.filePath,
        `${JSON.stringify({
          version: 1,
          timezone: "Asia/Shanghai",
          weekly: {},
          overrides: {}
        }, null, 2)}\n`
      );
    }
  }

  private readConfig(): RoutineFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      const config = validateRoutineFile(raw);
      this.lastValid = config;
      atomicWrite(this.lastValidPath, `${JSON.stringify(config, null, 2)}\n`);
      this.documentStatus = {
        path: this.filePath,
        valid: true,
        timezone: config.timezone,
        updatedAt: fs.statSync(this.filePath).mtime.toISOString()
      };
      return config;
    } catch (error) {
      this.documentStatus = {
        ...this.documentStatus,
        valid: false,
        updatedAt: fs.statSync(this.filePath).mtime.toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      return this.lastValid;
    }
  }

  private readLastValid(): RoutineFile {
    try {
      return validateRoutineFile(JSON.parse(fs.readFileSync(this.lastValidPath, "utf8")) as unknown);
    } catch {
      return { timezone: "Asia/Shanghai", weekly: {}, overrides: {} };
    }
  }
}

export class MemoryRoutineProvider implements RoutineProvider {
  constructor(private readonly blocks: RoutineBlock[] = []) {}
  getBlocks(): RoutineBlock[] {
    return this.blocks.map((block) => ({ ...block, tags: [...block.tags] }));
  }
}

function validateRoutineFile(value: unknown): RoutineFile {
  if (!isObject(value)) throw new Error("routine_root_invalid");
  const timezone = typeof value.timezone === "string" && value.timezone.trim()
    ? value.timezone.trim()
    : "Asia/Shanghai";
  return {
    timezone,
    weekly: normalizeBlockMap(value.weekly),
    overrides: normalizeBlockMap(value.overrides)
  };
}

function normalizeBlockMap(value: unknown): Record<string, RoutineFileBlock[]> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error("routine_blocks_invalid");
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (!Array.isArray(raw)) throw new Error(`routine_day_invalid:${key}`);
    return [key.toLowerCase(), raw.map((block, index) => normalizeBlock(block, `${key}:${index}`))];
  }));
}

function normalizeBlock(value: unknown, label: string): RoutineFileBlock {
  if (!isObject(value)) throw new Error(`routine_block_invalid:${label}`);
  const start = readTime(value.start, `${label}:start`);
  const end = readTime(value.end, `${label}:end`);
  const activity = typeof value.activity === "string" ? value.activity.trim() : "";
  const energy = value.energy;
  if (!activity) throw new Error(`routine_activity_missing:${label}`);
  if (energy !== "low" && energy !== "medium" && energy !== "high") {
    throw new Error(`routine_energy_invalid:${label}`);
  }
  if (typeof value.musicAllowed !== "boolean") throw new Error(`routine_music_allowed_invalid:${label}`);
  return {
    start,
    end,
    activity,
    expectedTags: value.expectedTags,
    energy,
    musicAllowed: value.musicAllowed
  };
}

function normalizeExpectedTags(value: unknown): MusicTag[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): MusicTag[] => {
    if (typeof raw === "string") {
      const [category, ...rest] = raw.split(":");
      if (rest.length > 0 && ["mood", "style", "scene"].includes(category!)) {
        return [{ category: category as "mood" | "style" | "scene", value: rest.join(":") }];
      }
      return [{ category: "mood", value: raw }];
    }
    if (isObject(raw) && typeof raw.category === "string" && typeof raw.value === "string") {
      if (["mood", "style", "scene"].includes(raw.category)) {
        return [{ category: raw.category as "mood" | "style" | "scene", value: raw.value }];
      }
    }
    return [];
  });
}

function readTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    throw new Error(`routine_time_invalid:${label}`);
  }
  return value;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
