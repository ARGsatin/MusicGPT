import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DailyPlanEngine, rollingWindow } from "../src/dailyPlan.js";
import { LocalRoutineProvider } from "../src/routineProvider.js";

describe("daily music plan", () => {
  it("keeps a connected secondary source visible instead of starving it behind familiar NCM tracks", () => {
    const familiarNcm = Array.from({ length: 160 }, (_, index) => ({
      track: {
        id: index + 1,
        trackKey: `ncm:${index + 1}`,
        recordingKey: `ncm-recording:${index + 1}`,
        source: "ncm" as const,
        sourceId: String(index + 1),
        title: `Familiar NCM ${index + 1}`,
        artists: [`NCM Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: 20
    }));
    const newQqLikes = Array.from({ length: 20 }, (_, index) => ({
      track: {
        id: `qq-${index + 1}`,
        trackKey: `qq:qq-${index + 1}`,
        recordingKey: `qq-recording:${index + 1}`,
        source: "qq" as const,
        sourceId: `qq-${index + 1}`,
        title: `New QQ Like ${index + 1}`,
        artists: [`QQ Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: 0,
      likedAt: "2026-08-15T00:00:00.000Z"
    }));
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats: [...familiarNcm, ...newQqLikes],
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "source diversity", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });

    expect(plan.segments.every((segment) => segment.items.some((item) => item.track.source === "qq"))).toBe(true);
    expect(rollingWindow(plan, new Date("2026-08-15T07:30:00+08:00"), 10)
      .some((item) => item.track.source === "qq")).toBe(true);
  });

  it("builds a deterministic four-period eight-hour plan without recording repeats", () => {
    const tracks = Array.from({ length: 160 }, (_, index) => ({
      track: {
        id: index + 1,
        trackKey: `ncm:${index + 1}`,
        recordingKey: `rec:${index + 1}`,
        source: "ncm" as const,
        sourceId: String(index + 1),
        title: `Track ${index + 1}`,
        artists: [`Artist ${index + 1}`],
        durationMs: 240_000,
        tags: [{ category: "mood" as const, value: index % 2 === 0 ? "energy" : "calm" }]
      },
      playCount: index % 9
    }));
    const engine = new DailyPlanEngine();
    const input = {
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats: tracks,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z",
        summary: "test",
        topArtists: [],
        topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0.5, focus: 0, warm: 0, night: 0, energy: 0.5, nostalgia: 0, unknown: 0 },
        preferenceTags: [],
        pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "clear" as const, temperature: 29 }
    };
    const first = engine.generate(input);
    const second = engine.generate(input);
    const keys = first.segments.flatMap((segment) => segment.items.map((item) => item.track.trackKey));

    expect(first.segments.map((segment) => segment.period)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "late_night"
    ]);
    expect(first.segments.reduce((total, segment) => total + segment.targetDurationMs, 0)).toBe(8 * 60 * 60 * 1000);
    expect(new Set(keys).size).toBe(keys.length);
    expect(second.segments.flatMap((segment) => segment.items.map((item) => item.track.trackKey))).toEqual(keys);
  });

  it("honors routine overrides and keeps the last valid file after invalid edits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-routine-"));
    const filePath = path.join(dir, "routine.json");
    fs.writeFileSync(filePath, JSON.stringify({
      timezone: "Asia/Shanghai",
      weekly: { saturday: [{ start: "13:00", end: "15:00", activity: "午休", expectedTags: ["calm"], energy: "low", musicAllowed: false }] },
      overrides: { "2026-08-15": [{ start: "18:00", end: "20:00", activity: "跑步", expectedTags: ["energy"], energy: "high", musicAllowed: true }] }
    }));
    const provider = new LocalRoutineProvider(filePath);
    expect(provider.getBlocks("2026-08-15", "Asia/Shanghai")).toEqual([
      expect.objectContaining({ activity: "跑步", musicAllowed: true })
    ]);
    fs.writeFileSync(filePath, "{invalid");
    expect(provider.getBlocks("2026-08-15", "Asia/Shanghai")).toEqual([
      expect.objectContaining({ activity: "跑步" })
    ]);
    expect(provider.status().valid).toBe(false);
    expect(new LocalRoutineProvider(filePath).getBlocks("2026-08-15", "Asia/Shanghai")).toEqual([
      expect.objectContaining({ activity: "跑步" })
    ]);
  });

  it("applies manual blocks, feedback cooldown and per-period weather before ranking", () => {
    const now = Date.now();
    const stats = Array.from({ length: 60 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Song ${index + 1}`,
        artists: [`Artist ${index % 10}`],
        durationMs: 240_000,
        moodTag: index % 2 === 0 ? "energy" as const : "calm" as const
      },
      playCount: 1
    }));
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: new Date(now).toISOString(), summary: "test", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: .5, focus: 0, warm: 0, night: 0, energy: .5, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: { "Artist 2": 2 }, tagWeights: {}, blockedArtists: ["Artist 1"], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" },
      weatherByPeriod: { morning: { weather: "clear", temperature: 30 }, late_night: { weather: "rain", temperature: 23 } },
      feedback: [
        { type: "skip", trackId: "ncm:3", at: new Date(now - 1_000).toISOString() },
        { type: "skip", trackId: "ncm:3", at: new Date(now - 2_000).toISOString() }
      ]
    });
    const items = plan.segments.flatMap((segment) => segment.items);
    expect(items.some((item) => item.track.artists.includes("Artist 1"))).toBe(false);
    expect(items.some((item) => item.track.id === 3)).toBe(false);
    expect(items[0]?.track.artists).toContain("Artist 2");
    expect(plan.segments[0]).toMatchObject({ weather: "clear", temperature: 30 });
    expect(plan.segments[3]).toMatchObject({ weather: "rain", temperature: 23 });
    for (let index = 0; index < items.length; index += 1) {
      const artist = items[index]!.track.artists[0];
      const previous = items.slice(Math.max(0, index - 4), index);
      expect(previous.some((item) => item.track.artists[0] === artist)).toBe(false);
    }
  });

  it("replans changed context while retaining current and consumed songs across midnight routine blocks", () => {
    const stats = Array.from({ length: 140 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Context ${index + 1}`,
        artists: [`Context Artist ${index + 1}`],
        durationMs: 240_000,
        moodTag: index % 2 === 0 ? "energy" as const : "calm" as const
      },
      playCount: index % 7
    }));
    const engine = new DailyPlanEngine();
    const common = {
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "context", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: .5, focus: 0, warm: 0, night: 0, energy: .5, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] }
    };
    const first = engine.generate({ ...common, routine: [], weather: { weather: "clear" as const } });
    const locked = first.segments[0]!.items.slice(0, 2).map((item) => item.track.trackKey!);
    const replanned = engine.generate({
      ...common,
      previous: first,
      currentTrackKey: locked[0]!,
      consumedTrackKeys: locked,
      weather: { weather: "rain" as const },
      routine: [{
        start: "23:00", end: "01:00", activity: "跨午夜睡眠", tags: [], energy: "low", musicAllowed: false
      }]
    });
    const replannedKeys = replanned.segments.flatMap((segment) => segment.items.map((item) => item.track.trackKey));

    expect(replanned.contextHash).not.toBe(first.contextHash);
    expect(replanned.consumedTrackKeys).toEqual(locked);
    expect(replannedKeys).toEqual(expect.arrayContaining(locked));
    expect(replanned.segments[3]?.targetDurationMs).toBe(60 * 60 * 1000);
  });
});
