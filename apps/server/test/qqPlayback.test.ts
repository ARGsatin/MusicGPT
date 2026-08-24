import { describe, expect, it, vi } from "vitest";

import { resolveQqPlayback } from "../src/qqPlayback.js";

describe("QQ playback client", () => {
  it("returns a playable URL from QQ's authenticated VKey response", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        comm: { uin: string; ct: number; authst?: string };
        req_0: { param: { filename: string[]; songmid: string[] } };
      };
      expect(init?.method).toBe("POST");
      expect(payload.comm).toMatchObject({ uin: "42", ct: 19, authst: "playback-ticket" });
      expect(payload.req_0.param.filename).toContain("M500media-mid.mp3");
      expect(payload.req_0.param.filename).not.toContain("M500song-midmedia-mid.mp3");
      expect(payload.req_0.param.songmid.every((value) => value === "song-mid")).toBe(true);
      return new Response(JSON.stringify({
        code: 0,
        req_0: {
          code: 0,
          data: {
            sip: ["https://stream.qq.example/"],
            midurlinfo: [
              { filename: "M800media-mid.mp3", result: 104003, purl: "" },
              { filename: "M500media-mid.mp3", result: 0, purl: "M500media-mid.mp3?vkey=redacted" }
            ]
          }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(resolveQqPlayback({
      sourceId: "song-mid",
      mediaId: "media-mid",
      cookie: "uin=42; qm_keyst=playback-ticket",
      fetchImpl
    })).resolves.toBe("https://stream.qq.example/M500media-mid.mp3?vkey=redacted");
  });
});
