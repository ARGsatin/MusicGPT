import { describe, expect, it } from "vitest";

import {
  encodeWsPayload,
  isChatRequest,
  isFeedbackRequest,
  isNextRequest,
  isPlayTrackRequest
} from "../src/contracts.js";

describe("contracts", () => {
  it("validates chat payload", () => {
    expect(isChatRequest({ message: "换点轻松的" })).toBe(true);
    expect(isChatRequest({ message: "" })).toBe(false);
  });

  it("validates feedback payload", () => {
    expect(isFeedbackRequest({ type: "like", trackId: 1 })).toBe(true);
    expect(isFeedbackRequest({ type: "oops", trackId: 1 })).toBe(false);
  });

  it("validates next payload", () => {
    expect(isNextRequest({ forceReplan: true })).toBe(true);
    expect(isNextRequest({ forceReplan: "yes" })).toBe(false);
  });

  it("validates suggested track playback payload", () => {
    expect(
      isPlayTrackRequest({
        track: { id: 99, title: "Night Drive", artists: ["Ari"] },
        reason: "matches the requested mood"
      })
    ).toBe(true);
    expect(isPlayTrackRequest({ track: { id: "99", title: "Night Drive", artists: ["Ari"] } })).toBe(false);
  });

  it("encodes ws payload", () => {
    expect(encodeWsPayload({ event: "queue_updated", data: { n: 1 } })).toBe(
      "{\"event\":\"queue_updated\",\"data\":{\"n\":1}}"
    );
  });
});
