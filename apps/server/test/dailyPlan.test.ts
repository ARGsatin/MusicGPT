import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DailyPlanEngine, playbackSegment, rollingWindow } from "../src/dailyPlan.js";
import { ListeningPolicy } from "../src/listeningPolicy.js";
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

  it("builds a deterministic three-period ten-track plan without recording repeats", () => {
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
      "evening"
    ]);
    expect(first.segments.map((segment) => [segment.start, segment.end])).toEqual([
      ["2026-08-15T06:00:00+08:00", "2026-08-15T12:00:00+08:00"],
      ["2026-08-15T12:00:00+08:00", "2026-08-15T18:00:00+08:00"],
      ["2026-08-15T18:00:00+08:00", "2026-08-16T00:00:00+08:00"]
    ]);
    expect(first.segments.map((segment) => segment.items.length)).toEqual([10, 10, 10]);
    expect(first.segments.map((segment) => segment.targetDurationMs)).toEqual([
      40 * 60 * 1000,
      40 * 60 * 1000,
      40 * 60 * 1000
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(second.segments.flatMap((segment) => segment.items.map((item) => item.track.trackKey))).toEqual(keys);
  });

  it("gives morning discovery, afternoon softness and evening long-term favorites", () => {
    const makeStat = (
      id: number,
      title: string,
      playCount: number,
      tags: Array<{ category: "style" | "scene"; value: string }> = [],
      moodTag: "calm" | "energy" | "unknown" = "unknown"
    ) => ({
      track: {
        id,
        trackKey: `ncm:${id}`,
        recordingKey: `rec:${id}`,
        source: "ncm" as const,
        sourceId: String(id),
        title,
        artists: [`Artist ${id}`],
        durationMs: 240_000,
        moodTag,
        tags
      },
      playCount
    });
    const stats = [
      ...Array.from({ length: 4 }, (_, index) => makeStat(index + 1, `Discover ${index + 1}`, 0)),
      ...Array.from({ length: 2 }, (_, index) => makeStat(
        index + 11,
        `Classical ${index + 1}`,
        3,
        [{ category: "style", value: "古典/器乐" }],
        "calm"
      )),
      ...Array.from({ length: 5 }, (_, index) => makeStat(index + 21, `Soft ${index + 1}`, 3, [], "calm")),
      ...Array.from({ length: 8 }, (_, index) => makeStat(index + 31, `Memory ${index + 1}`, 100 - index)),
      ...Array.from({ length: 24 }, (_, index) => makeStat(index + 51, `Filler ${index + 1}`, 2, [], "energy"))
    ];
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "themes", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0.5, focus: 0, warm: 0, night: 0, energy: 0.5, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });
    const [morning, afternoon, evening] = plan.segments;
    const isSoft = (title: string) => title.startsWith("Classical") || title.startsWith("Soft");

    expect(morning?.items.filter((item) => item.bucket === "explore")).toHaveLength(4);
    expect(afternoon?.items.filter((item) => isSoft(item.track.title)).length).toBeGreaterThanOrEqual(7);
    expect(afternoon?.items.filter((item) => item.track.title.startsWith("Classical"))).toHaveLength(2);
    expect(evening?.items.filter((item) => item.track.title.startsWith("Memory")).length).toBeGreaterThanOrEqual(8);
    expect(morning?.items.some((item) => item.reason.includes("晨间探索"))).toBe(true);
    expect(afternoon?.items.some((item) => item.reason.includes("午后柔和"))).toBe(true);
    expect(evening?.items.some((item) => item.reason.includes("晚间回忆"))).toBe(true);
  });

  it("keeps morning exploration near forty percent and spreads it through the segment", () => {
    const stats = [
      ...Array.from({ length: 20 }, (_, index) => ({
        track: {
          id: index + 1,
          title: `Explore ${index + 1}`,
          artists: [`Explore Artist ${index + 1}`],
          durationMs: 240_000
        },
        playCount: 0
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        track: {
          id: index + 101,
          title: `Familiar ${index + 1}`,
          artists: [`Familiar Artist ${index + 1}`],
          durationMs: 240_000
        },
        playCount: 1
      }))
    ];
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "balanced discovery", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });
    const morning = plan.segments[0]!.items;
    const explorePositions = morning
      .map((item, index) => item.bucket === "explore" ? index : -1)
      .filter((index) => index >= 0);

    expect(explorePositions).toEqual([0, 3, 6, 9]);
  });

  it("applies feedback cooldown to every source variant of the same recording", () => {
    const sharedRecording = "rec:shared";
    const stats = [
      {
        track: {
          id: 1,
          trackKey: "ncm:1",
          recordingKey: sharedRecording,
          source: "ncm" as const,
          sourceId: "1",
          title: "Shared recording",
          artists: ["Shared Artist"],
          durationMs: 240_000
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-shared",
          trackKey: "qq:qq-shared",
          recordingKey: sharedRecording,
          source: "qq" as const,
          sourceId: "qq-shared",
          title: "Shared recording",
          artists: ["Shared Artist"],
          durationMs: 240_000
        },
        playCount: 0
      },
      {
        track: {
          id: 2,
          trackKey: "ncm:2",
          recordingKey: "rec:known",
          source: "ncm" as const,
          sourceId: "2",
          title: "Known recording",
          artists: ["Known Artist"],
          durationMs: 240_000
        },
        playCount: 80
      },
      {
        track: {
          id: "qq-known",
          trackKey: "qq:qq-known",
          recordingKey: "rec:known",
          source: "qq" as const,
          sourceId: "qq-known",
          title: "Known recording",
          artists: ["Known Artist"],
          durationMs: 240_000
        },
        playCount: 0
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        track: {
          id: index + 10,
          trackKey: `ncm:${index + 10}`,
          recordingKey: `rec:${index + 10}`,
          source: "ncm" as const,
          sourceId: String(index + 10),
          title: `Safe ${index + 1}`,
          artists: [`Safe Artist ${index + 1}`],
          durationMs: 240_000
        },
        playCount: index % 4
      }))
    ];
    const now = Date.now();
    const policy = new ListeningPolicy({ now: () => new Date(now) });
    policy.observe({
      observationId: "shared-recording-cooldown",
      kind: "explicit_feedback",
      track: stats[1]!.track,
      reason: "overplayed",
      scope: "long_term",
      at: new Date(now - 1_000).toISOString()
    });
    const plan = new DailyPlanEngine(policy).generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: new Date(now).toISOString(), summary: "cooldown", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" },
      feedback: [],
      policyMode: "adaptive"
    });

    const items = plan.segments.flatMap((segment) => segment.items);
    expect(items.some((item) => item.track.recordingKey === sharedRecording)).toBe(false);
    expect(items.find((item) => item.track.recordingKey === "rec:known")?.bucket).toBe("familiar");
  });

  it("does not square manual tag weights when inferred and evidence tags overlap", () => {
    const stats = [
      {
        track: {
          id: 1,
          title: "Single calm tag",
          artists: ["Artist One"],
          moodTag: "calm" as const,
          durationMs: 240_000
        },
        playCount: 1
      },
      {
        track: {
          id: 2,
          title: "Duplicate calm tag",
          artists: ["Artist Two"],
          moodTag: "calm" as const,
          tagEvidence: [{ category: "mood" as const, value: "calm", confidence: 0.95, source: "ai" as const }],
          durationMs: 240_000
        },
        playCount: 1
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        track: {
          id: index + 10,
          title: `Weight filler ${index + 1}`,
          artists: [`Weight Artist ${index + 1}`],
          durationMs: 240_000
        },
        playCount: 1
      }))
    ];
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "deduped tags", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 1, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: { "mood:calm": 2 }, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });
    const items = plan.segments.flatMap((segment) => segment.items);
    const single = items.find((item) => item.track.id === 1);
    const duplicate = items.find((item) => item.track.id === 2);

    expect(single?.score).toBeTypeOf("number");
    expect(duplicate?.score).toBe(single?.score);
  });

  it("uses the themed source variant when a reserved recording has mixed metadata", () => {
    const themedVariants = [1, 2].flatMap((id) => [
      {
        track: {
          id: `qq-mixed-${id}`,
          trackKey: `qq:qq-mixed-${id}`,
          recordingKey: `rec:mixed-${id}`,
          source: "qq" as const,
          sourceId: `qq-mixed-${id}`,
          title: `Mixed ${id}`,
          artists: [`Mixed Artist ${id}`],
          moodTag: "energy" as const,
          durationMs: 240_000
        },
        playCount: 3
      },
      {
        track: {
          id: id + 500,
          trackKey: `ncm:${id + 500}`,
          recordingKey: `rec:mixed-${id}`,
          source: "ncm" as const,
          sourceId: String(id + 500),
          title: `Mixed ${id}`,
          artists: [`Mixed Artist ${id}`],
          moodTag: "calm" as const,
          tags: [{ category: "style" as const, value: "古典/器乐" }],
          durationMs: 240_000
        },
        playCount: 3
      }
    ]);
    const stats = [
      ...themedVariants,
      ...Array.from({ length: 50 }, (_, index) => ({
        track: {
          id: index + 1_000,
          title: `Mixed filler ${index + 1}`,
          artists: [`Mixed Filler Artist ${index + 1}`],
          moodTag: "energy" as const,
          durationMs: 240_000
        },
        playCount: 3
      }))
    ];
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z", summary: "mixed source tags", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 1, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: { "mood:energy": 10 }, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });
    const mixed = plan.segments[1]!.items.filter((item) => item.track.recordingKey?.startsWith("rec:mixed"));

    expect(mixed).toHaveLength(2);
    expect(mixed.every((item) => item.track.source === "ncm" && item.reason.includes("古典/器乐"))).toBe(true);
  });

  it("does not label low-history profile top tracks as long-term memories", () => {
    const stats = Array.from({ length: 36 }, (_, index) => ({
      track: {
        id: index + 1,
        trackKey: `ncm:${index + 1}`,
        recordingKey: `rec:${index + 1}`,
        source: "ncm" as const,
        sourceId: String(index + 1),
        title: `Low History ${index + 1}`,
        artists: [`Low Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: index === 0 ? 0 : 1,
      ...(index === 0 ? { lastPlayedAt: "2026-08-14T12:00:00.000Z" } : {})
    }));
    const plan = new DailyPlanEngine().generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z",
        summary: "low history",
        topArtists: [{ name: "Low Artist 1", weight: 1 }],
        topTracks: stats.slice(0, 12).map((stat) => ({ id: stat.track.trackKey, title: stat.track.title, playCount: 1 })),
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [],
        pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });

    expect(plan.segments[2]?.items.filter((item) => item.reason.includes("晚间回忆"))).toHaveLength(0);
    expect(plan.segments.flatMap((segment) => segment.items)
      .find((item) => item.track.trackKey === "ncm:1")?.bucket).toBe("familiar");
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
    const stats = [
      {
        track: {
          id: 999,
          title: "Moonlit No. 3",
          artists: ["Composer X"],
          durationMs: 240_000,
          moodTag: "calm" as const,
          tagEvidence: [{ category: "style" as const, value: "古典/器乐", confidence: 0.95, source: "ai" as const }]
        },
        playCount: 20
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        track: {
          id: index + 1,
          title: `Song ${index + 1}`,
          artists: [`Artist ${index % 10}`],
          durationMs: 240_000,
          moodTag: index % 2 === 0 ? "energy" as const : "calm" as const
        },
        playCount: 1
      }))
    ];
    const policy = new ListeningPolicy({ now: () => new Date(now) });
    policy.observe({
      observationId: "daily-plan-recording-cooldown",
      kind: "explicit_feedback",
      track: stats.find((stat) => stat.track.id === 3)!.track,
      reason: "overplayed",
      scope: "long_term",
      at: new Date(now - 1_000).toISOString()
    });
    const plan = new DailyPlanEngine(policy).generate({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      stats,
      profile: {
        generatedAt: new Date(now).toISOString(), summary: "test", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: .5, focus: 0, warm: 0, night: 0, energy: .5, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: {
        artistWeights: { "Artist 2": 2 },
        tagWeights: {},
        blockedArtists: ["Artist 1"],
        blockedTags: ["style:古典/器乐"]
      },
      routine: [],
      weather: { weather: "unknown" },
      weatherByPeriod: { morning: { weather: "clear", temperature: 30 }, evening: { weather: "rain", temperature: 23 } },
      feedback: [],
      policyMode: "adaptive"
    });
    const items = plan.segments.flatMap((segment) => segment.items);
    expect(items.some((item) => item.track.artists.includes("Artist 1"))).toBe(false);
    expect(items.some((item) => item.track.id === 999)).toBe(false);
    expect(items.some((item) => item.track.id === 3)).toBe(false);
    expect(items[0]?.track.artists).toContain("Artist 2");
    expect(plan.segments[0]).toMatchObject({ weather: "clear", temperature: 30 });
    expect(plan.segments[2]).toMatchObject({ weather: "rain", temperature: 23 });
    for (let index = 0; index < items.length; index += 1) {
      const artist = items[index]!.track.artists[0];
      const previous = items.slice(Math.max(0, index - 4), index);
      expect(previous.some((item) => item.track.artists[0] === artist)).toBe(false);
    }
  });

  it("blocks every source variant when taste.md blocks one version of a recording", () => {
    const sharedRecording = "recording:manual-block";
    const sharedVariants = [
      {
        track: {
          id: 9_001,
          trackKey: "ncm:9001",
          recordingKey: sharedRecording,
          source: "ncm" as const,
          sourceId: "9001",
          title: "Blocked recording",
          artists: ["Shared artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-9001",
          trackKey: "qq:qq-9001",
          recordingKey: sharedRecording,
          source: "qq" as const,
          sourceId: "qq-9001",
          title: "Blocked recording",
          artists: ["Shared artist"]
        },
        playCount: 100
      }
    ];
    const safe = Array.from({ length: 10 }, (_, index) => ({
      track: {
        id: index + 1,
        trackKey: `ncm:${index + 1}`,
        recordingKey: `recording:safe-${index + 1}`,
        source: "ncm" as const,
        sourceId: String(index + 1),
        title: `Safe ${index + 1}`,
        artists: [`Safe artist ${index + 1}`]
      },
      playCount: 1
    }));
    const common = {
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats: [...sharedVariants, ...safe],
      candidates: [{
        track: {
          id: "search-9001",
          trackKey: "qq:search-9001",
          recordingKey: sharedRecording,
          source: "qq" as const,
          sourceId: "search-9001",
          title: "Blocked recording",
          artists: ["Shared artist"],
          tags: [{ category: "style" as const, value: "metal" }]
        },
        source: "context_search" as const,
        tags: [],
        relevanceScore: 0.9,
        discoveredAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-08-26T00:00:00.000Z"
      }],
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "manual block", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: ["style:metal"] },
      routine: [],
      weather: { weather: "unknown" as const }
    };

    for (const policyMode of ["legacy", "shadow", "adaptive"] as const) {
      const plan = new DailyPlanEngine().generate({ ...common, policyMode });
      expect(
        plan.segments.flatMap((segment) => segment.items)
          .some((item) => item.track.recordingKey === sharedRecording),
        policyMode
      ).toBe(false);
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
    expect(replanned.segments[2]?.items).toHaveLength(10);
    expect(replanned.segments[2]?.targetDurationMs).toBe(40 * 60 * 1000);
    expect(replanned.segments[2]?.end).toBe("2026-08-16T00:00:00+08:00");

    const silenced = engine.generate({
      ...common,
      routine: [
        { start: "18:00", end: "22:00", activity: "安静时间", tags: [], energy: "low", musicAllowed: false },
        { start: "21:00", end: "24:00", activity: "休息", tags: [], energy: "low", musicAllowed: false }
      ],
      weather: { weather: "clear" as const }
    });
    expect(silenced.segments[2]?.items).toHaveLength(0);
    expect(silenced.segments[2]?.targetDurationMs).toBe(0);
  });

  it("selects the current or next themed period at public time boundaries", () => {
    const plan = {
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      revision: 1,
      generatedAt: "2026-08-15T00:00:00.000Z",
      contextHash: "boundaries",
      consumedTrackKeys: [],
      segments: [
        { period: "morning" as const, start: "2026-08-15T06:00:00+08:00", end: "2026-08-15T12:00:00+08:00", targetDurationMs: 0, weather: "unknown" as const, routine: [], items: [] },
        { period: "afternoon" as const, start: "2026-08-15T12:00:00+08:00", end: "2026-08-15T18:00:00+08:00", targetDurationMs: 0, weather: "unknown" as const, routine: [], items: [] },
        { period: "evening" as const, start: "2026-08-15T18:00:00+08:00", end: "2026-08-16T00:00:00+08:00", targetDurationMs: 0, weather: "unknown" as const, routine: [], items: [] }
      ]
    };

    expect([
      "2026-08-15T00:00:00+08:00",
      "2026-08-15T06:00:00+08:00",
      "2026-08-15T11:59:59+08:00",
      "2026-08-15T12:00:00+08:00",
      "2026-08-15T17:59:59+08:00",
      "2026-08-15T18:00:00+08:00",
      "2026-08-15T23:59:59+08:00"
    ].map((at) => playbackSegment(plan, new Date(at))?.period)).toEqual([
      "morning",
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening"
    ]);
  });

  it("admits fresh recommendation candidates into the morning exploration quota", () => {
    const stats = Array.from({ length: 40 }, (_, index) => ({
      track: {
        id: index + 1,
        trackKey: `ncm:${index + 1}`,
        recordingKey: `recording:known-${index + 1}`,
        source: "ncm" as const,
        sourceId: String(index + 1),
        title: `Known ${index + 1}`,
        artists: [`Known Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: 10
    }));
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      track: {
        id: 100 + index,
        trackKey: `ncm:${100 + index}`,
        recordingKey: `recording:fresh-${index + 1}`,
        source: "ncm" as const,
        sourceId: String(100 + index),
        title: `Fresh Daily ${index + 1}`,
        artists: [`Fresh Artist ${index + 1}`],
        durationMs: 240_000,
        moodTag: "energy" as const
      },
      source: "ncm_daily" as const,
      tags: [{ category: "mood" as const, value: "energy" }],
      relevanceScore: 1,
      discoveredAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-26T00:00:00.000Z"
    }));

    const plan = new DailyPlanEngine().generate({
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats,
      candidates,
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "candidate pool", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 1, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "clear" }
    });

    expect(plan.segments[0]?.items.filter((item) => item.source === "ncm_daily")).toHaveLength(4);
    expect(plan.segments[0]?.items.filter((item) => item.bucket === "explore")).toHaveLength(4);
  });

  it("uses the active desired mood when rebuilding the unplayed daily plan", () => {
    const makeStats = (mood: "calm" | "energy", offset: number, playCount: number) =>
      Array.from({ length: 36 }, (_, index) => ({
        track: {
          id: offset + index,
          trackKey: `ncm:${offset + index}`,
          recordingKey: `recording:${offset + index}`,
          source: "ncm" as const,
          sourceId: String(offset + index),
          title: `${mood} ${index + 1}`,
          artists: [`${mood} Artist ${index + 1}`],
          moodTag: mood,
          durationMs: 240_000
        },
        playCount
      }));
    const common = {
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats: [...makeStats("energy", 1, 20), ...makeStats("calm", 101, 1)],
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "energy baseline", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 1, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" as const }
    };
    const engine = new DailyPlanEngine();
    const baseline = engine.generate(common);
    const calm = engine.generate({ ...common, desiredMood: "calm" });

    expect(calm.contextHash).not.toBe(baseline.contextHash);
    expect(calm.segments[0]?.items[0]?.track.moodTag).toBe("calm");
  });

  it("uses an evidence-backed quota adjustment without exceeding the morning guardrail", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `daily-quota-${++sequence}`
    });
    for (let index = 0; index < 20; index += 1) {
      policy.observe({
        observationId: `daily-complete-${index}`,
        kind: "playback_outcome",
        track: {
          id: index + 1,
          trackKey: `ncm:${index + 1}`,
          recordingKey: `history:${index + 1}`,
          source: "ncm",
          sourceId: String(index + 1),
          title: `History ${index + 1}`,
          artists: [`History Artist ${index + 1}`]
        },
        outcome: "completed",
        listenedMs: 90_000,
        durationMs: 100_000,
        at: `2026-08-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        sessionId: `session-${index % 2}`,
        dayPeriod: "morning"
      });
    }
    const stats = Array.from({ length: 45 }, (_, index) => ({
      track: {
        id: 100 + index,
        trackKey: `ncm:${100 + index}`,
        recordingKey: `known:${index + 1}`,
        source: "ncm" as const,
        sourceId: String(100 + index),
        title: `Known quota ${index + 1}`,
        artists: [`Known quota artist ${index + 1}`]
      },
      playCount: 10
    }));
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      track: {
        id: 500 + index,
        trackKey: `ncm:${500 + index}`,
        recordingKey: `fresh-quota:${index + 1}`,
        source: "ncm" as const,
        sourceId: String(500 + index),
        title: `Fresh quota ${index + 1}`,
        artists: [`Fresh quota artist ${index + 1}`]
      },
      source: "ncm_daily" as const,
      tags: [],
      relevanceScore: 1,
      discoveredAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-26T00:00:00.000Z"
    }));
    const plan = new DailyPlanEngine(policy).generate({
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats,
      candidates,
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "adaptive quota", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" }
    });

    expect(plan.segments[0]?.items.filter((item) => item.bucket === "explore")).toHaveLength(5);
  });

  it("keeps legacy daily ordering in shadow mode and applies session intent only in adaptive mode", () => {
    const stats = [
      ...Array.from({ length: 36 }, (_, index) => ({
        track: {
          id: index + 1,
          title: `Energy shadow ${index + 1}`,
          artists: [`Energy shadow artist ${index + 1}`],
          moodTag: "energy" as const
        },
        playCount: 20
      })),
      ...Array.from({ length: 36 }, (_, index) => ({
        track: {
          id: index + 101,
          title: `Calm shadow ${index + 1}`,
          artists: [`Calm shadow artist ${index + 1}`],
          moodTag: "calm" as const
        },
        playCount: 1
      }))
    ];
    const common = {
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats,
      desiredMood: "calm",
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "shadow", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 1, nostalgia: 0, unknown: 0 },
        preferenceTags: [], pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" as const }
    };
    const engine = new DailyPlanEngine();
    const legacy = engine.generate({ ...common, policyMode: "legacy" });
    const shadow = engine.generate({ ...common, policyMode: "shadow" });
    const adaptive = engine.generate({ ...common, policyMode: "adaptive" });

    expect(legacy.segments[0]?.items[0]?.track.moodTag).toBe("energy");
    expect(shadow.segments[0]?.items[0]?.track.trackKey).toBe(legacy.segments[0]?.items[0]?.track.trackKey);
    expect(shadow.segments[0]?.items[0]?.decisionId).toBeUndefined();
    expect(shadow.segments[0]?.items[0]?.evidence).toBeUndefined();
    expect(shadow.segments[0]?.items[0]?.policyVersion).toBeUndefined();
    expect(adaptive.segments[0]?.items[0]?.track.moodTag).toBe("calm");
  });

  it("reports one computed shadow ranking for every daily period", () => {
    const rankings: string[] = [];
    new DailyPlanEngine().generate({
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats: Array.from({ length: 36 }, (_, index) => ({
        track: {
          id: index + 1,
          title: `Shadow audit ${index + 1}`,
          artists: [`Shadow artist ${index + 1}`]
        },
        playCount: index + 1
      })),
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "shadow audit", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" },
      policyMode: "shadow",
      onShadowRanking: (period, decisions) => {
        expect(decisions.length).toBeGreaterThan(0);
        rankings.push(period);
      }
    });

    expect(rankings.sort()).toEqual(["afternoon", "evening", "morning"]);
  });

  it("keeps the radio available when adaptive daily ranking fails", () => {
    class FailingPolicy extends ListeningPolicy {
      override rank(): never {
        throw new Error("daily ranking failed");
      }
    }
    const failures: string[] = [];
    const plan = new DailyPlanEngine(new FailingPolicy()).generate({
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats: Array.from({ length: 36 }, (_, index) => ({
        track: { id: index + 1, title: `Fallback ${index + 1}`, artists: [`Fallback artist ${index + 1}`] },
        playCount: 1
      })),
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "fallback", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced"
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" },
      policyMode: "adaptive",
      onPolicyError: (error) => failures.push(error instanceof Error ? error.message : String(error))
    });

    expect(plan.segments.map((segment) => segment.items.length)).toEqual([10, 10, 10]);
    expect(failures).toEqual(["daily ranking failed", "daily ranking failed", "daily ranking failed"]);
  });

  it("uses a complete legacy fallback and invalidates it after adaptive ranking recovers", () => {
    class RecoveringPolicy extends ListeningPolicy {
      failing = true;

      override rank(request: Parameters<ListeningPolicy["rank"]>[0]): ReturnType<ListeningPolicy["rank"]> {
        if (this.failing) throw new Error("transient ranking failure");
        return super.rank(request);
      }
    }
    const policy = new RecoveringPolicy({ now: () => new Date("2026-08-25T08:00:00.000Z") });
    for (let index = 0; index < 20; index += 1) {
      policy.observe({
        observationId: `fallback-quota-${index}`,
        kind: "playback_outcome",
        track: {
          id: `quota-${index}`,
          trackKey: `ncm:quota-${index}`,
          recordingKey: `recording:quota-${index}`,
          source: "ncm",
          sourceId: `quota-${index}`,
          title: `Quota evidence ${index}`,
          artists: [`Quota artist ${index}`]
        },
        outcome: "completed",
        listenedMs: 90_000,
        durationMs: 100_000,
        at: `2026-08-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        sessionId: `quota-session-${index % 2}`,
        dayPeriod: "morning"
      });
    }
    const skippedTrack = {
      id: 8_888,
      trackKey: "ncm:8888",
      recordingKey: "recording:legacy-cooldown",
      source: "ncm" as const,
      sourceId: "8888",
      title: "Legacy cooldown",
      artists: ["Cooldown artist"]
    };
    const stats = [
      { track: skippedTrack, playCount: 1_000 },
      ...Array.from({ length: 5 }, (_, index) => ({
        track: {
          id: 9_000 + index,
          trackKey: `ncm:${9_000 + index}`,
          recordingKey: `recording:fresh-fallback-${index}`,
          source: "ncm" as const,
          sourceId: String(9_000 + index),
          title: `Fresh fallback ${index}`,
          artists: [`Fresh fallback artist ${index}`]
        },
        playCount: 0
      })),
      ...Array.from({ length: 35 }, (_, index) => ({
        track: {
          id: 10_000 + index,
          trackKey: `ncm:${10_000 + index}`,
          recordingKey: `recording:known-fallback-${index}`,
          source: "ncm" as const,
          sourceId: String(10_000 + index),
          title: `Known fallback ${index}`,
          artists: [`Known fallback artist ${index}`]
        },
        playCount: 2
      }))
    ];
    const feedback = [
      { type: "skip" as const, trackId: skippedTrack.trackKey, at: "2026-08-25T07:59:00.000Z" },
      { type: "skip" as const, trackId: skippedTrack.trackKey, at: "2026-08-25T07:58:00.000Z" }
    ];
    const common = {
      date: "2026-08-25",
      timezone: "Asia/Shanghai",
      stats,
      feedback,
      profile: {
        generatedAt: "2026-08-25T00:00:00.000Z", summary: "fallback boundary", topArtists: [], topTracks: [],
        favoritePeriods: [],
        moodWeights: { calm: 0, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 1 },
        preferenceTags: [], pacingPreference: "balanced" as const
      },
      rules: { artistWeights: {}, tagWeights: {}, blockedArtists: [], blockedTags: [] },
      routine: [],
      weather: { weather: "unknown" as const }
    };
    const engine = new DailyPlanEngine(policy);
    const legacy = engine.generate({ ...common, policyMode: "legacy" });
    const fallback = engine.generate({ ...common, policyMode: "adaptive" });
    const keys = (plan: typeof fallback) => plan.segments.flatMap((segment) =>
      segment.items.map((item) => item.track.trackKey)
    );

    expect(keys(fallback)).toEqual(keys(legacy));
    expect(fallback.segments[0]?.items.filter((item) => item.bucket === "explore")).toHaveLength(4);
    expect(keys(fallback)).not.toContain(skippedTrack.trackKey);

    policy.failing = false;
    const recovered = engine.generate({ ...common, policyMode: "adaptive", previous: fallback });
    expect(recovered.contextHash).not.toBe(fallback.contextHash);
    expect(recovered.segments.flatMap((segment) => segment.items)
      .some((item) => item.decisionId)).toBe(true);
  });
});
