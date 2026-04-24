import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NcmConnector } from "../src/ncmConnector.js";
import { StateRepository } from "../src/stateRepository.js";

describe("NcmConnector integration", () => {
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

  it("returns empty data for anonymous account payload", async () => {
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

    const connector = new NcmConnector("http://mock-ncm", "cookie=abc", mockFetch);
    const stats = await connector.fetchUserMusicData();

    expect(stats).toEqual([]);
  });
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
