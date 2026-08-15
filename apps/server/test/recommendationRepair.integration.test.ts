import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe("recommendation data repair", () => {
  it("repairs legacy metadata, preserves favorites, and rebuilds a clean queue on startup", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-recommendation-repair-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    repo.upsertTrackStats([
      ...Array.from({ length: 9 }, (_, index) => ({
        track: {
          id: index + 1,
          title: `Known Song ${index + 1}`,
          artists: [`Known Artist ${index + 1}`]
        },
        playCount: 20 - index
      })),
      {
        track: { id: 90, title: "夜晚雷雨声 白噪音ASMR睡眠", artists: [] },
        playCount: 3,
        localFavoritedAt: "2026-08-01T00:00:00.000Z"
      }
    ]);
    repo.upsertRecommendationCandidates([
      {
        track: { id: 91, title: "Nostalgia for a Cup", artists: [] },
        source: "context_search",
        tags: [{ category: "period", value: "午后" }],
        relevanceScore: 1,
        discoveredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    ]);
    repo.saveNowPlaying({
      track: { id: 1, title: "Known Song 1", artists: ["Known Artist 1"] },
      queue: [
        {
          track: { id: 91, title: "Nostalgia for a Cup", artists: [] },
          score: 0.9,
          reason: "legacy queue",
          bucket: "explore",
          source: "context_search"
        }
      ],
      paused: false
    });

    const ncm = new NcmConnector("http://mock-ncm", "MUSIC_U=test", async (input) => {
      const url = input.toString();
      if (url.includes("/song/detail")) {
        return json({
          songs: [
            {
              id: 90,
              name: "夜晚雷雨声 白噪音ASMR睡眠",
              ar: [{ name: "Nature Lab" }],
              al: { name: "Sleep Sounds" },
              dt: 3600000
            }
          ]
        });
      }
      if (url.includes("/recommend/songs")) {
        return json({ data: { dailySongs: [] } });
      }
      if (url.includes("/login/status")) {
        return json({});
      }
      if (url.includes("/lyric")) {
        return json({ nolyric: true });
      }
      return json({});
    });
    const environment = {
      dayPeriod: "afternoon" as const,
      weather: "storm" as const,
      updatedAt: new Date().toISOString()
    };
    const app = await createServer({
      repo,
      ncm,
      environmentService: {
        getContext: () => environment,
        updateLocation: async () => environment
      },
      importRetryIntervalMs: 60_000
    });
    servers.push(app);

    const response = await app.inject({ method: "GET", url: "/api/now" });
    const now = response.json();
    expect(now.track).toMatchObject({ id: 1, artists: ["Known Artist 1"] });
    expect(now.queue.length).toBeLessThanOrEqual(10);
    expect(now.queue.every((item: { track: { artists: string[] } }) => item.track.artists.length > 0)).toBe(true);
    expect(now.queue.map((item: { track: { id: number } }) => item.track.id)).not.toContain(90);
    expect(now.queue.map((item: { track: { id: number } }) => item.track.id)).not.toContain(91);
    expect(repo.getRecommendationCandidates()).toHaveLength(0);
    expect(repo.getTrackStats().find((stat) => stat.track.id === 90)).toMatchObject({
      track: { artists: ["Nature Lab"] },
      playCount: 3,
      localFavoritedAt: "2026-08-01T00:00:00.000Z"
    });
  });
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
