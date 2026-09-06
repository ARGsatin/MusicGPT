import { describe, expect, it } from "vitest";

import { reconnectDelayMs, shouldRestoreOnOpen, WS_RECONNECT_DELAYS_MS } from "./useWsStream";

describe("websocket reconnection policy", () => {
  it("uses the required capped 1/2/5/10/30 second schedule", () => {
    expect(WS_RECONNECT_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
    expect(reconnectDelayMs(99, () => 0.5)).toBe(30_000);
  });

  it("adds bounded random jitter", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(800);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_200);
  });

  it("restores after a failed initial attempt as well as a later reconnect", () => {
    expect(shouldRestoreOnOpen(false, true)).toBe(true);
    expect(shouldRestoreOnOpen(true, false)).toBe(true);
    expect(shouldRestoreOnOpen(false, false)).toBe(false);
  });
});
