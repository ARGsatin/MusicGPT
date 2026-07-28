import { describe, expect, it } from "vitest";

import {
  buildEdgeTtsWebSocketUrl,
  extractEdgeTtsAudioPayload,
  generateSecMsGec
} from "../src/edgeTtsClient.js";

describe("edge TTS transport", () => {
  it("generates the current Sec-MS-GEC handshake token in five-minute windows", () => {
    const now = Date.UTC(2026, 6, 28, 8, 4, 59);

    expect(generateSecMsGec(now)).toBe(
      "E009D51F6F87A147F65A6808C1009F7EB20AC6E13DB38AA311E1334F250D2901"
    );
    expect(generateSecMsGec(now - 4 * 60 * 1_000)).toBe(generateSecMsGec(now));
  });

  it("includes the DRM token and Chromium version in the websocket URL", () => {
    const url = new URL(
      buildEdgeTtsWebSocketUrl(Date.UTC(2026, 6, 28, 8, 4, 59), "connection-1")
    );

    expect(url.searchParams.get("TrustedClientToken")).toBe(
      "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    );
    expect(url.searchParams.get("Sec-MS-GEC")).toBe(generateSecMsGec(Date.UTC(2026, 6, 28, 8)));
    expect(url.searchParams.get("Sec-MS-GEC-Version")).toMatch(/^1-\d+\.\d+\.\d+\.\d+$/);
    expect(url.searchParams.get("ConnectionId")).toBe("connection-1");
  });

  it("extracts only the MP3 bytes from binary websocket frames", () => {
    const headers = Buffer.from(
      "X-RequestId:request-1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"
    );
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    const frame = Buffer.concat([
      Buffer.from([(headers.length >> 8) & 0xff, headers.length & 0xff]),
      headers,
      audio
    ]);

    expect(extractEdgeTtsAudioPayload(frame)).toEqual(audio);
    expect(extractEdgeTtsAudioPayload(Buffer.from([0, 0]))).toBeUndefined();
  });
});
