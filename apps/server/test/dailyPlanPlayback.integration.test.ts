import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MusicSourceAdapter } from "../src/musicCatalog.js";
import { MusicCatalog } from "../src/musicCatalog.js";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  vi.useRealTimers();
  while (servers.length > 0) await servers.pop()?.close();
});

describe("daily-plan playback API", () => {
  it("starts the current segment and replaces the queue with its remaining songs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T13:30:00+08:00"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-daily-playback-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.upsertTrackStats(Array.from({ length: 160 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Plan Track ${index + 1}`,
        artists: [`Plan Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: index % 8
    })));
    repo.saveRecommendationDataVersion(2);
    repo.saveNowPlaying({
      track: { id: 9_999, title: "Before one-click", artists: ["Old Artist"] },
      queue: Array.from({ length: 10 }, (_, index) => ({
        track: { id: 9_000 + index, title: `Old Queue ${index}`, artists: [`Old ${index}`] },
        score: 0.1,
        reason: "old queue",
        source: "library" as const,
        bucket: "familiar" as const
      })),
      paused: false
    });
    const app = await createServer({
      repo,
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch),
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const planResponse = await app.inject({ method: "GET", url: "/api/daily-plan" });
    const plan = planResponse.json() as {
      segments: Array<{
        period: string;
        items: Array<{ track: { trackKey: string } }>;
      }>;
    };
    const afternoon = plan.segments.find((segment) => segment.period === "afternoon")!;

    const response = await app.inject({ method: "POST", url: "/api/daily-plan/play" });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      period: string;
      now: {
        track?: { trackKey: string };
        queue: Array<{ track: { trackKey: string } }>;
      };
    };
    expect(payload.period).toBe("afternoon");
    expect(payload.now.track?.trackKey).toBe(afternoon.items[0]?.track.trackKey);
    expect(payload.now.queue.map((item) => item.track.trackKey)).toEqual(
      afternoon.items.slice(1, 11).map((item) => item.track.trackKey)
    );
  });

  it("replaces a persisted legacy four-period plan on first read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T08:00:00+08:00"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-daily-migration-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const stats = Array.from({ length: 60 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Migration Track ${index + 1}`,
        artists: [`Migration Artist ${index + 1}`],
        durationMs: 240_000
      },
      playCount: index % 20
    }));
    repo.upsertTrackStats(stats);
    repo.saveRecommendationDataVersion(2);
    const legacyItems = stats.slice(0, 11).map((stat) => ({
      track: stat.track,
      score: 0.5,
      reason: "legacy",
      source: "library" as const,
      bucket: "familiar" as const
    }));
    repo.saveDailyPlan({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      revision: 7,
      generatedAt: "2026-08-15T00:00:00.000Z",
      contextHash: "legacy-four-period-planner",
      consumedTrackKeys: [],
      segments: [
        { period: "morning", start: "2026-08-15T07:00:00+08:00", end: "2026-08-15T09:00:00+08:00", targetDurationMs: 7_200_000, weather: "unknown", routine: [], items: legacyItems },
        { period: "afternoon", start: "2026-08-15T13:00:00+08:00", end: "2026-08-15T15:00:00+08:00", targetDurationMs: 7_200_000, weather: "unknown", routine: [], items: legacyItems },
        { period: "evening", start: "2026-08-15T18:00:00+08:00", end: "2026-08-15T20:00:00+08:00", targetDurationMs: 7_200_000, weather: "unknown", routine: [], items: legacyItems },
        { period: "late_night", start: "2026-08-15T22:00:00+08:00", end: "2026-08-15T23:59:59+08:00", targetDurationMs: 7_200_000, weather: "unknown", routine: [], items: legacyItems }
      ]
    });
    const app = await createServer({
      repo,
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch),
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const response = await app.inject({ method: "GET", url: "/api/daily-plan" });
    const plan = response.json() as {
      revision: number;
      segments: Array<{ period: string; end: string; items: unknown[] }>;
    };
    expect(plan.revision).toBe(8);
    expect(plan.segments.map((segment) => segment.period)).toEqual(["morning", "afternoon", "evening"]);
    expect(plan.segments.every((segment) => segment.items.length <= 10)).toBe(true);
    expect(plan.segments[2]?.end).toBe("2026-08-16T00:00:00+08:00");
  });

  it("consumes the planned QQ key when playback falls back to the same NCM recording", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-15T08:00:00+08:00"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-daily-source-fallback-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const recordingKey = "rec:source-fallback";
    const qqTrack = {
      id: "qq-fallback",
      trackKey: "qq:qq-fallback",
      recordingKey,
      source: "qq" as const,
      sourceId: "qq-fallback",
      title: "Source Fallback",
      artists: ["Fallback Artist"],
      durationMs: 200_000
    };
    const ncmTrack = {
      id: 88,
      trackKey: "ncm:88",
      recordingKey,
      source: "ncm" as const,
      sourceId: "88",
      title: "Source Fallback",
      artists: ["Fallback Artist"],
      durationMs: 200_000
    };
    const fillerStats = Array.from({ length: 40 }, (_, index) => ({
      track: {
        id: index + 100,
        title: `Fallback filler ${index + 1}`,
        artists: [`Fallback filler artist ${index + 1}`],
        durationMs: 240_000,
        songUrl: `https://ncm.example/${index + 100}.mp3`
      },
      playCount: 2
    }));
    repo.upsertTrackStats([
      { track: qqTrack, playCount: 3 },
      { track: ncmTrack, playCount: 3 },
      ...fillerStats
    ]);
    repo.saveRecommendationDataVersion(2);
    const planItem = {
      track: qqTrack,
      score: 0.9,
      reason: "晨间口味",
      source: "library" as const,
      bucket: "familiar" as const
    };
    repo.saveDailyPlan({
      date: "2026-08-15",
      timezone: "Asia/Shanghai",
      revision: 1,
      generatedAt: "2026-08-15T00:00:00.000Z",
      contextHash: "source-fallback",
      consumedTrackKeys: [],
      segments: [
        { period: "morning", start: "2026-08-15T06:00:00+08:00", end: "2026-08-15T12:00:00+08:00", targetDurationMs: 200_000, weather: "unknown", routine: [], items: [planItem] },
        { period: "afternoon", start: "2026-08-15T12:00:00+08:00", end: "2026-08-15T18:00:00+08:00", targetDurationMs: 0, weather: "unknown", routine: [], items: [] },
        { period: "evening", start: "2026-08-15T18:00:00+08:00", end: "2026-08-16T00:00:00+08:00", targetDurationMs: 0, weather: "unknown", routine: [], items: [] }
      ]
    });
    repo.saveNowPlaying({
      track: {
        id: 999,
        trackKey: "ncm:999",
        source: "ncm",
        sourceId: "999",
        title: "Current before fallback",
        artists: ["Current Artist"],
        songUrl: "https://ncm.example/999.mp3"
      },
      queue: [
        planItem,
        ...fillerStats.slice(0, 9).map((stat) => ({
          track: stat.track,
          score: 0.5,
          reason: "existing queue",
          source: "library" as const,
          bucket: "familiar" as const
        }))
      ],
      paused: false
    });
    const source = (
      name: "qq" | "ncm",
      track: typeof qqTrack | typeof ncmTrack,
      playback?: string
    ): MusicSourceAdapter => ({
      source: name,
      status: async () => ({ source: name, enabled: true, connected: false }),
      sync: async () => ({ source: name, tracks: [track], evidence: [], warnings: [] }),
      search: async () => [track],
      recommend: async () => [track],
      resolvePlayback: async () => playback,
      getLyrics: async () => ({ trackId: track.trackKey, pureMusic: true, lines: [] })
    });
    const catalog = new MusicCatalog([
      source("qq", qqTrack),
      source("ncm", ncmTrack, "https://ncm.example/88.mp3")
    ]);
    const app = await createServer({
      repo,
      catalog,
      ncm: new NcmConnector("http://mock-ncm", "cookie=abc", mockNcmFetch),
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const response = await app.inject({ method: "POST", url: "/api/queue/qq%3Aqq-fallback/play" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ now: { track: { trackKey: "ncm:88" } } });
    expect(repo.getDailyPlan()?.consumedTrackKeys).toEqual(expect.arrayContaining([
      "qq:qq-fallback",
      "ncm:88"
    ]));
    expect(repo.getNowPlaying()?.queue.some((item) => item.track.trackKey === "qq:qq-fallback")).toBe(false);
  });
});

async function mockNcmFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(input.toString());
  if (url.pathname.includes("/song/url")) {
    const id = Number(url.searchParams.get("id"));
    return json({ data: [{ id, url: `https://ncm.example/${id}.mp3` }] });
  }
  if (url.pathname.includes("/lyric")) return json({ nolyric: true });
  return json({ code: 200, account: { id: 1 }, profile: { userId: 1 } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
