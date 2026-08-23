import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { QqMusicAdapter, type QqMusicClient } from "../src/qqMusicAdapter.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

describe("v2 public APIs", () => {
  it("authorizes and syncs QQ without exposing credentials, then serves plans and QQ audio", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-v2-api-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.upsertTrackStats([{ track: { id: 1, title: "NCM Base", artists: ["NCM"] }, playCount: 4 }]);
    const qqClient: QqMusicClient = {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,qr", token: "server-token", signature: "server-signature" }),
      checkQr: async () => ({ status: "authorized", accountId: "88", accountLabel: "QQ Listener", cookie: "uin=88; secret=cookie" }),
      listPlaylists: async () => ({ total: 1, items: [{ id: "liked", name: "我喜欢", liked: true }] }),
      getPlaylistTracks: async () => [{ sourceId: "qq-mid-1", title: "QQ Song", artists: ["QQ Artist"], durationMs: 200_000 }],
      search: async () => [{ sourceId: "qq-mid-1", title: "QQ Song", artists: ["QQ Artist"], durationMs: 200_000 }],
      resolvePlayback: async () => "https://qq.example/song.mp3",
      getLyrics: async () => ({ pureMusic: false, lines: [{ timeMs: 0, text: "QQ lyric" }] })
    };
    const qqMusic = new QqMusicAdapter(dir, qqClient);
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", async (input) => {
      const url = input.toString();
      if (url.includes("/song/url")) return json({ data: [{ id: 1, url: "https://ncm.example/1.mp3" }] });
      if (url.includes("/lyric")) return json({ nolyric: true });
      return json({ code: 200, account: { id: 1 }, profile: { userId: 1 } });
    });
    const app = await createServer({ repo, ncm, qqMusic, importRetryIntervalMs: 60_000 });
    servers.push(app);

    const qr = await app.inject({ method: "POST", url: "/api/music-sources/qq/auth/qr" });
    expect(qr.statusCode).toBe(200);
    expect(qr.body).not.toContain("server-token");
    expect(qr.body).not.toContain("cookie");
    const sessionId = (qr.json() as { sessionId: string }).sessionId;
    const authorized = await app.inject({ method: "GET", url: `/api/music-sources/qq/auth/qr/${sessionId}` });
    expect(authorized.json()).toMatchObject({ status: "authorized" });
    expect(authorized.body).not.toContain("secret=cookie");

    const sync = await app.inject({ method: "POST", url: "/api/music-sources/qq/sync" });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ source: "qq", importedCount: 1, evidenceCount: 1 });
    expect(sync.body).not.toContain("secret=cookie");
    expect(repo.getTrackStats(100).find((stat) => stat.track.trackKey === "qq:qq-mid-1")?.likedAt)
      .toBeTypeOf("string");

    const sources = await app.inject({ method: "GET", url: "/api/music-sources" });
    expect(sources.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "qq", connected: true, accountLabel: "QQ Listener" })
    ]));
    expect(sources.body).not.toContain("secret=cookie");

    const library = await app.inject({ method: "GET", url: "/api/library/export" });
    expect(library.body).toContain("qq:qq-mid-1");
    const taste = await app.inject({ method: "GET", url: "/api/taste" });
    expect(taste.json()).toEqual(expect.objectContaining({ manualRules: expect.any(Object), document: expect.objectContaining({ valid: true }) }));
    const plan = await app.inject({ method: "GET", url: "/api/daily-plan" });
    expect((plan.json() as { segments: unknown[] }).segments).toHaveLength(4);

    const audio = await app.inject({ method: "GET", url: "/api/tracks/qq%3Aqq-mid-1/audio" });
    expect(audio.statusCode).toBe(302);
    expect(audio.headers.location).toBe("https://qq.example/song.mp3");

    const legacyFavorite = await app.inject({
      method: "PUT",
      url: "/api/favorites/1",
      payload: { favorite: true }
    });
    expect(legacyFavorite.statusCode).toBe(200);
    expect(repo.isTrackFavorite("ncm:1")).toBe(true);
  });

  it("keeps the current song and reports an unavailable queued QQ track instead of silently switching", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-v2-qq-unavailable-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const current = {
      id: 1,
      trackKey: "ncm:1",
      source: "ncm" as const,
      sourceId: "1",
      title: "Current Song",
      artists: ["Current Artist"],
      songUrl: "https://ncm.example/1.mp3"
    };
    const unavailableQq = {
      id: "qq-paid-mid",
      trackKey: "qq:qq-paid-mid",
      source: "qq" as const,
      sourceId: "qq-paid-mid",
      title: "Paid QQ Song",
      artists: ["QQ Artist"],
      durationMs: 200_000,
      requiresSubscription: true
    };
    const ncmQueue = Array.from({ length: 9 }, (_, index) => ({
      track: {
        id: 10 + index,
        title: `Next ${10 + index}`,
        artists: ["Next Artist"],
        songUrl: `https://ncm.example/${10 + index}.mp3`
      },
      score: 0.8,
      reason: "Queued next",
      source: "library" as const,
      bucket: "familiar" as const
    }));
    repo.saveNowPlaying({
      track: current,
      queue: [{
        track: unavailableQq,
        score: 0.9,
        reason: "QQ recommendation",
        source: "library",
        bucket: "familiar"
      }, ...ncmQueue],
      paused: false
    });
    repo.ensureTrack(unavailableQq);
    repo.saveRecommendationDataVersion(2);
    const qqMusic = new QqMusicAdapter(dir, {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,qr", token: "token", signature: "signature" }),
      checkQr: async () => ({ status: "pending" }),
      listPlaylists: async () => ({ total: 0, items: [] }),
      getPlaylistTracks: async () => [],
      search: async () => [],
      resolvePlayback: async () => undefined,
      getLyrics: async () => ({ pureMusic: true, lines: [] })
    });
    const ncm = new NcmConnector("http://mock-ncm", "cookie=abc", async (input) => {
      const url = input.toString();
      if (url.includes("/cloudsearch")) return json({ result: { songs: [] } });
      if (url.includes("/lyric")) return json({ nolyric: true });
      return json({ code: 200, account: { id: 1 }, profile: { userId: 1 } });
    });
    const app = await createServer({ repo, ncm, qqMusic, importRetryIntervalMs: 60_000 });
    servers.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/queue/qq%3Aqq-paid-mid/play"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "qq_subscription_required" });
    const now = await app.inject({ method: "GET", url: "/api/now" });
    expect(now.json()).toMatchObject({ track: { trackKey: "ncm:1" } });
    expect(now.body).not.toContain("qq:qq-paid-mid");
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
