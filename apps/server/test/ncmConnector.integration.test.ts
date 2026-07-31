import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { StateRepository } from "../src/stateRepository.js";

describe("NcmConnector integration", () => {
  it("parses logged-in daily recommendations into playable track metadata", async () => {
    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", async (input) => {
      expect(input.toString()).toContain("/recommend/songs");
      return json({
        data: {
          dailySongs: [
            {
              id: 901,
              name: "Daily Jazz",
              ar: [{ name: "Cloud Trio" }],
              al: { name: "Morning Set", picUrl: "https://example.com/cover.jpg" },
              dt: 203000
            }
          ]
        }
      });
    });

    await expect(connector.fetchDailyRecommendations()).resolves.toEqual([
      expect.objectContaining({
        id: 901,
        title: "Daily Jazz",
        artists: ["Cloud Trio"],
        album: "Morning Set",
        coverUrl: "https://example.com/cover.jpg",
        durationMs: 203000
      })
    ]);
  });

  it("reads the current cookie for every request so QR recovery needs no server restart", async () => {
    let cookie = "MUSIC_U=old";
    const seenCookies: string[] = [];
    const connector = new NcmConnector(
      "http://mock-ncm",
      () => cookie,
      async (_input, init) => {
        seenCookies.push(new Headers(init?.headers).get("Cookie") ?? "");
        return json({});
      }
    );

    await connector.isReachable();
    cookie = "MUSIC_U=new";
    await connector.isReachable();

    expect(seenCookies).toEqual(["MUSIC_U=old", "MUSIC_U=new"]);
  });

  it("imports user data and persists into repository", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/user/account")) {
        return json({
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        });
      }
      if (url.includes("/likelist")) {
        return json({ ids: [{ id: 1, t: Date.now() }] });
      }
      if (url.includes("/song/detail")) {
        return json({
          songs: [{ id: 1, name: "Test Song", ar: [{ name: "Test Artist" }], dt: 200000 }]
        });
      }
      if (url.includes("/user/record")) {
        return json({
          allData: [{ playCount: 66, song: { id: 1, name: "Test Song", ar: [{ name: "Test Artist" }] } }]
        });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "cookie=abc", mockFetch);
    const stats = await connector.fetchUserMusicData();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-db-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    repo.upsertTrackStats(stats);

    expect(repo.getTrackStats(10)).toHaveLength(1);
    expect(repo.getTrackStats(10)[0]?.playCount).toBe(66);
  });

  it("reports an unreachable NCM API instead of treating it as an empty library", async () => {
    const connector = new NcmConnector(
      "http://mock-ncm",
      "MUSIC_U=test",
      async () => {
        throw new TypeError("fetch failed");
      }
    );

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_unreachable"
    });
  });

  it("classifies a local request timeout separately from an unreachable API", async () => {
    const connector = new NcmConnector(
      "http://mock-ncm",
      "MUSIC_U=test",
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
    );

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_request_failed",
      message: expect.stringContaining("超时")
    });
  });

  it("retries a transient upstream failure during import", async () => {
    let likeListAttempts = 0;
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/login/status")) {
        return json({
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        });
      }
      if (url.includes("/likelist")) {
        likeListAttempts += 1;
        if (likeListAttempts === 1) {
          return json({ code: 502, msg: "upstream timeout" }, 502);
        }
        return json({ ids: [1] });
      }
      if (url.includes("/song/detail")) {
        return json({
          songs: [{ id: 1, name: "Recovered", ar: [{ name: "NCM" }] }]
        });
      }
      if (url.includes("/user/record")) {
        return json({ allData: [] });
      }
      return json({});
    };
    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    const stats = await connector.fetchUserMusicData();

    expect(stats).toHaveLength(1);
    expect(likeListAttempts).toBe(2);
  });

  it("reports an expired login instead of treating it as an empty library", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/user/account")) {
        return json({
          account: { id: 12345, anonimousUser: true, status: -10 },
          profile: null
        });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_not_logged_in"
    });
  });

  it("keeps an explicit login failure even if the fallback account request times out", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/login/status")) {
        return json({ code: 301, msg: "需要登录" });
      }
      throw new TypeError("fetch failed");
    };

    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_not_logged_in"
    });
  });

  it("reports an empty liked-song list explicitly", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/user/account")) {
        return json({
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        });
      }
      if (url.includes("/likelist")) {
        return json({ ids: [] });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_likes_empty"
    });
  });

  it("reports a malformed liked-song response as an API compatibility failure", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/login/status")) {
        return json({
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        });
      }
      if (url.includes("/likelist")) {
        return json({ code: 200 });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_request_failed"
    });
  });

  it("reports incompatible song-detail data explicitly", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/user/account")) {
        return json({
          account: { id: 9527, anonimousUser: false, status: 0 },
          profile: { userId: 9527 }
        });
      }
      if (url.includes("/likelist")) {
        return json({ ids: [1] });
      }
      if (url.includes("/song/detail")) {
        return json({ songs: [] });
      }
      if (url.includes("/user/record")) {
        return json({ allData: [] });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "MUSIC_U=test", mockFetch);

    await expect(connector.fetchUserMusicData()).rejects.toMatchObject({
      code: "ncm_track_details_empty"
    });
  });

  it("parses timed lyrics and merges matching translated lines", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/lyric")) {
        return json({
          nolyric: false,
          lrc: {
            lyric:
              "[00:00.000] 作词 : Someone\n[00:05.720]I won't see you tonight\n[00:12.430]But I don't know enough"
          },
          tlyric: {
            lyric: "[00:05.720]今晚若见你\n[00:12.430]但我不解"
          }
        });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "cookie=abc", mockFetch);
    const lyrics = await connector.fetchLyrics(5253801);

    expect(lyrics).toEqual({
      trackId: 5253801,
      pureMusic: false,
      lines: [
        { timeMs: 5720, text: "I won't see you tonight", translation: "今晚若见你" },
        { timeMs: 12430, text: "But I don't know enough", translation: "但我不解" }
      ]
    });
  });

  it("returns pure music lyrics for nolyric payloads", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/lyric")) {
        return json({ nolyric: true, lrc: { lyric: "" } });
      }
      return json({});
    };

    const connector = new NcmConnector("http://mock-ncm", "cookie=abc", mockFetch);
    const lyrics = await connector.fetchLyrics(1313354324);

    expect(lyrics).toEqual({
      trackId: 1313354324,
      pureMusic: true,
      lines: []
    });
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
