import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
