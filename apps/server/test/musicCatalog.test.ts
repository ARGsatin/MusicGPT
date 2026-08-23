import { describe, expect, it } from "vitest";

import {
  MusicCatalog,
  type MusicSourceAdapter,
  type MusicSourceSyncResult
} from "../src/musicCatalog.js";

import type { MusicSource, MusicSourceStatus, Track, TrackLyrics } from "@musicgpt/shared";

class FakeSource implements MusicSourceAdapter {
  playbackCalls = 0;

  constructor(
    readonly source: MusicSource,
    private readonly tracks: Track[],
    private readonly playable = new Map<string, string>()
  ) {}

  async status(): Promise<MusicSourceStatus> {
    return { source: this.source, enabled: true, connected: true };
  }

  async sync(): Promise<MusicSourceSyncResult> {
    return { source: this.source, tracks: this.tracks, evidence: [], warnings: [] };
  }

  async search(): Promise<Track[]> {
    return this.tracks;
  }

  async recommend(): Promise<Track[]> {
    return this.tracks;
  }

  async resolvePlayback(track: Track): Promise<string | undefined> {
    this.playbackCalls += 1;
    return this.playable.get(track.sourceId ?? String(track.id));
  }

  async getLyrics(track: Track): Promise<TrackLyrics> {
    return { trackId: track.trackKey ?? String(track.id), pureMusic: true, lines: [] };
  }
}

describe("MusicCatalog", () => {
  it("deduplicates the same recording across providers and falls back to a playable variant", async () => {
    const ncm = new FakeSource("ncm", [
      { id: 101, title: "Same Song", artists: ["Artist"], durationMs: 200_000 }
    ]);
    const qq = new FakeSource(
      "qq",
      [{ id: "003abc", title: "Same Song", artists: ["Artist"], durationMs: 202_000 }],
      new Map([["003abc", "https://example.test/qq.mp3"]])
    );
    const catalog = new MusicCatalog([ncm, qq]);

    const matches = await catalog.search("Same Song");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      trackKey: "ncm:101",
      source: "ncm",
      sourceId: "101"
    });
    const resolved = await catalog.resolvePlayback(matches[0]!);
    expect(resolved).toMatchObject({
      url: "https://example.test/qq.mp3",
      track: { trackKey: "qq:003abc", source: "qq" }
    });
  });

  it("keeps ambiguous recordings separate when their durations differ by more than five seconds", async () => {
    const catalog = new MusicCatalog([
      new FakeSource("ncm", [
        { id: 1, title: "Same Song", artists: ["Artist"], durationMs: 200_000 }
      ]),
      new FakeSource("qq", [
        { id: "long", title: "Same Song", artists: ["Artist"], durationMs: 208_000 }
      ])
    ]);

    expect(await catalog.search("Same Song")).toHaveLength(2);
  });

  it("falls back from an unavailable QQ VIP/copyright variant and cools that version down", async () => {
    const qq = new FakeSource("qq", [
      { id: "vip-mid", title: "Fallback Song", artists: ["Artist"], durationMs: 201_000 }
    ]);
    const ncm = new FakeSource(
      "ncm",
      [{ id: 88, title: "Fallback Song", artists: ["Artist"], durationMs: 200_000 }],
      new Map([["88", "https://example.test/ncm-88.mp3"]])
    );
    const catalog = new MusicCatalog([qq, ncm]);
    const [qqMatch] = await catalog.search("Fallback Song");

    expect((await catalog.resolvePlayback(qqMatch!))?.track.trackKey).toBe("ncm:88");
    expect((await catalog.resolvePlayback(qqMatch!))?.url).toBe("https://example.test/ncm-88.mp3");
    expect(qq.playbackCalls).toBe(1);
    expect(ncm.playbackCalls).toBe(2);
  });

  it("discovers an NCM fallback when a queued QQ-only recording is unavailable", async () => {
    const qq = new FakeSource("qq", []);
    const ncm = new FakeSource(
      "ncm",
      [{ id: 99, title: "Queue Song", artists: ["Queue Artist"], durationMs: 200_000 }],
      new Map([["99", "https://example.test/ncm-99.mp3"]])
    );
    const catalog = new MusicCatalog([qq, ncm]);
    const [queuedQq] = catalog.registerTracks([{
      id: "qq-only-mid",
      source: "qq",
      sourceId: "qq-only-mid",
      title: "Queue Song",
      artists: ["Queue Artist"],
      durationMs: 202_000
    }]);

    const resolved = await catalog.resolvePlayback(queuedQq!);

    expect(resolved).toMatchObject({
      url: "https://example.test/ncm-99.mp3",
      track: { trackKey: "ncm:99", source: "ncm" }
    });
  });
});
