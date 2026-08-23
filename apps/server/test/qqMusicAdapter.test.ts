import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractQqPlaylistTracks,
  QqMusicAdapter,
  type QqMusicClient,
  type QqPlaylistPage
} from "../src/qqMusicAdapter.js";

describe("QQ Music adapter", () => {
  it("extracts songs from the nested cdlist returned by the playlist-detail service", () => {
    const tracks = extractQqPlaylistTracks({
      status: 200,
      body: {
        response: {
          code: 0,
          data: {
            cdlist: [{
              dissname: "我喜欢",
              songlist: [{
                songmid: "003abc",
                songid: 12345,
                songname: "QQ Song",
                singer: [{ name: "QQ Artist" }],
                interval: 201,
                file: { media_mid: "001media" },
                pay: { payplay: 1 }
              }]
            }]
          }
        }
      }
    });

    expect(tracks).toEqual([{
      sourceId: "003abc",
      playbackId: "001media",
      lyricsId: "12345",
      requiresSubscription: true,
      title: "QQ Song",
      artists: ["QQ Artist"],
      durationMs: 201_000
    }]);
  });

  it("uses the preserved QQ media and lyrics identifiers at provider boundaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-qq-identifiers-"));
    const playbackCalls: unknown[][] = [];
    const lyricCalls: unknown[][] = [];
    const client: QqMusicClient = {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,abc", token: "token", signature: "sig" }),
      checkQr: async () => ({ status: "pending" }),
      listPlaylists: async () => ({ total: 0, items: [] }),
      getPlaylistTracks: async () => [],
      search: async () => [],
      resolvePlayback: async (...args) => {
        playbackCalls.push(args);
        return "https://stream.qq.example/song.mp3";
      },
      getLyrics: async (...args) => {
        lyricCalls.push(args);
        return { pureMusic: true, lines: [] };
      }
    };
    const adapter = new QqMusicAdapter(dir, client);
    const track = {
      id: "003abc",
      source: "qq" as const,
      sourceId: "003abc",
      playbackId: "001media",
      lyricsId: "12345",
      requiresSubscription: true,
      title: "QQ Song",
      artists: ["QQ Artist"]
    };

    await adapter.resolvePlayback(track);
    await adapter.getLyrics(track);

    expect(playbackCalls).toEqual([["003abc", undefined, {
      playbackId: "001media",
      requiresSubscription: true
    }]]);
    expect(lyricCalls).toEqual([["003abc", undefined, "12345"]]);
  });

  it("keeps QR secrets server-side, persists the cookie locally and paginates account playlists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-qq-"));
    const pages: number[] = [];
    const client: QqMusicClient = {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,abc", token: "token", signature: "sig" }),
      checkQr: async () => ({ status: "authorized", cookie: "uin=42; secret=hidden", accountId: "42", accountLabel: "QQ 42" }),
      listPlaylists: async ({ offset }): Promise<QqPlaylistPage> => {
        pages.push(offset);
        return offset === 0
          ? { total: 2, items: [{ id: "liked", name: "我喜欢", liked: true }] }
          : { total: 2, items: [{ id: "mine", name: "夜间散步" }] };
      },
      getPlaylistTracks: async (playlistId) => [
        {
          sourceId: `${playlistId}-song`,
          title: playlistId === "liked" ? "Liked Song" : "Walk Song",
          artists: ["QQ Artist"],
          durationMs: 200_000
        }
      ],
      search: async () => [],
      resolvePlayback: async () => undefined,
      getLyrics: async () => ({ pureMusic: true, lines: [] })
    };
    const adapter = new QqMusicAdapter(dir, client, { pageSize: 1 });

    const qr = await adapter.createQr();
    expect(qr).toEqual(expect.objectContaining({ imageDataUrl: "data:image/png;base64,abc" }));
    expect(JSON.stringify(qr)).not.toContain("token");
    expect(await adapter.pollQr(qr.sessionId)).toMatchObject({ status: "authorized" });
    expect(await adapter.status()).toMatchObject({ connected: true, accountLabel: "QQ 42" });

    const result = await adapter.sync();
    expect(pages).toEqual([0, 1]);
    expect(result.tracks.map((track) => track.trackKey)).toEqual([
      "qq:liked-song",
      "qq:mine-song"
    ]);
    expect(result.evidence.map((item) => item.kind)).toEqual(["platform_like", "playlist"]);
    expect(result.warnings).toContain("qq_recent_plays_unavailable");

    const persisted = fs.readFileSync(path.join(dir, "qqmusic", "session.json"), "utf8");
    expect(persisted).toContain("secret=hidden");
    expect(JSON.stringify(await adapter.status())).not.toContain("secret=hidden");
  });

  it("reports expired QR sessions and disconnected-cookie failures without leaking credentials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-qq-expired-"));
    const adapter = new QqMusicAdapter(dir, {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,abc", token: "token", signature: "sig" }),
      checkQr: async () => ({ status: "expired", message: "二维码已过期" }),
      listPlaylists: async () => ({ total: 0, items: [] }),
      getPlaylistTracks: async () => [],
      search: async () => [],
      resolvePlayback: async () => undefined,
      getLyrics: async () => ({ pureMusic: true, lines: [] })
    });
    const qr = await adapter.createQr();
    expect(await adapter.pollQr(qr.sessionId)).toMatchObject({ status: "expired" });
    await expect(adapter.sync()).rejects.toThrow("qq_not_connected");
  });

  it("classifies an expired account cookie and redacts it from status and errors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-qq-cookie-expired-"));
    const adapter = new QqMusicAdapter(dir, {
      createQr: async () => ({ imageDataUrl: "data:image/png;base64,abc", token: "token", signature: "sig" }),
      checkQr: async () => ({
        status: "authorized",
        cookie: "uin=42; qm_keyst=top-secret",
        accountId: "42"
      }),
      listPlaylists: async () => {
        throw new Error("401 Cookie expired cookie=uin=42; qm_keyst=top-secret");
      },
      getPlaylistTracks: async () => [],
      search: async () => [],
      resolvePlayback: async () => undefined,
      getLyrics: async () => ({ pureMusic: true, lines: [] })
    });
    const qr = await adapter.createQr();
    await adapter.pollQr(qr.sessionId);

    await expect(adapter.sync()).rejects.toThrow("qq_cookie_expired");
    const serialized = JSON.stringify(await adapter.status());
    expect(serialized).toContain("qq_cookie_expired");
    expect(serialized).not.toContain("top-secret");
  });
});
