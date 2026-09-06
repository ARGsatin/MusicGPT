import { describe, expect, it, vi } from "vitest";

import { createPlaybackOutcomeReporter } from "./playbackOutcomeReporter";

describe("playback outcome reporter", () => {
  it("shares one request for concurrent final events with the same playback id", async () => {
    const send = vi.fn(async () => ({ duplicate: false }));
    const reporter = createPlaybackOutcomeReporter(send, { retryDelaysMs: [] });
    const request = {
      playbackId: "play-1",
      trackId: "qq:abc",
      outcome: "skipped" as const,
      listenedMs: 8_000,
      durationMs: 200_000
    };

    await Promise.all([reporter.report(request), reporter.report(request)]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("allows retry after a network failure but not after acceptance", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ duplicate: false });
    const reporter = createPlaybackOutcomeReporter(send, { retryDelaysMs: [] });
    const request = {
      playbackId: "play-2",
      trackId: 2,
      outcome: "completed" as const,
      listenedMs: 180_000,
      durationMs: 200_000
    };

    await expect(reporter.report(request)).rejects.toThrow("offline");
    await reporter.report(request);
    await reporter.report(request);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries a final outcome a bounded number of times", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue({ duplicate: false });
    const reporter = createPlaybackOutcomeReporter(send, {
      retryDelaysMs: [1, 1],
      wait: async () => undefined
    });

    await reporter.report({
      playbackId: "play-retry",
      trackId: 7,
      outcome: "completed",
      listenedMs: 100_000
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("uses a page-leave beacon once and suppresses duplicate final events", async () => {
    const send = vi.fn(async () => ({ duplicate: false }));
    const beacon = vi.fn(() => true);
    const reporter = createPlaybackOutcomeReporter(send);
    const request = {
      playbackId: "play-leave",
      trackId: 8,
      outcome: "abandoned" as const,
      listenedMs: 12_000
    };

    expect(reporter.reportBeacon(request, beacon)).toBe(true);
    await reporter.report(request);
    expect(beacon).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
