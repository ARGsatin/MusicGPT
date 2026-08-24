import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TrackTagEnricher } from "../src/trackTagEnricher.js";

describe("TrackTagEnricher", () => {
  it("caches AI intrinsic tags by model/version and never persists context tags", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tags-"));
    const complete = vi.fn(async () => ({
      "ncm:1": [
        { category: "style" as const, value: "dream pop", confidence: 0.88 },
        { category: "weather" as const, value: "rain", confidence: 0.9 }
      ]
    }));
    const enricher = new TrackTagEnricher(path.join(dir, "cache.json"), {
      model: "test-model",
      tagVersion: 2,
      complete
    });
    const track = { id: 1, title: "Dream", artists: ["Artist"] };

    const first = await enricher.enrich([track]);
    const second = await enricher.enrich([track]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first[0]?.tagEvidence).toEqual([
      expect.objectContaining({ category: "style", value: "dream pop", source: "ai" })
    ]);
    expect(second).toEqual(first);
  });

  it("falls back to local intrinsic tags when the model fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-tags-fallback-"));
    const enricher = new TrackTagEnricher(path.join(dir, "cache.json"), {
      model: "test-model",
      tagVersion: 2,
      complete: async () => { throw new Error("offline"); }
    });
    const [track] = await enricher.enrich([{ id: 2, title: "Night Walk", artists: ["Artist"] }]);
    expect(track?.tagEvidence?.length).toBeGreaterThan(0);
    expect(track?.tagEvidence?.every((tag) => ["artist", "mood", "style", "scene"].includes(tag.category))).toBe(true);
  });
});
