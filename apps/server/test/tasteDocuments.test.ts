import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TasteDocumentManager } from "../src/tasteDocuments.js";

describe("taste and library documents", () => {
  it("exports intrinsic tags and preserves manual frontmatter outside the managed section", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-taste-doc-"));
    const manager = new TasteDocumentManager(dir);
    await manager.refresh({
      profile: {
        generatedAt: "2026-08-15T00:00:00.000Z",
        summary: "偏爱夜间的温暖流行乐",
        topArtists: [{ name: "Artist", weight: 1 }],
        topTracks: [{ id: "qq:one", title: "One", playCount: 3 }],
        favoritePeriods: [{ period: "late_night", weight: 1 }],
        moodWeights: { calm: 0, focus: 0, warm: 1, night: 0, energy: 0, nostalgia: 0, unknown: 0 },
        preferenceTags: [],
        pacingPreference: "balanced"
      },
      stats: [{
        track: {
          id: "one",
          trackKey: "qq:one",
          recordingKey: "rec:one",
          source: "qq",
          sourceId: "one",
          title: "One",
          artists: ["Artist"],
          tags: [
            { category: "style", value: "流行" },
            { category: "weather", value: "雨" },
            { category: "period", value: "深夜" }
          ]
        },
        playCount: 3,
        localFavoritedAt: "2026-08-14T00:00:00.000Z"
      }],
      events: [{ type: "complete", trackId: "qq:one", at: "2026-08-14T00:00:00.000Z" }]
    });

    const tastePath = path.join(dir, "taste.md");
    const authored = fs.readFileSync(tastePath, "utf8").replace(
      /^---[\s\S]*?---/u,
      "---\nartistWeights:\n  Artist: 1.8\ntagWeights: {}\nblockedArtists: []\nblockedTags:\n  - style:metal\n---"
    );
    fs.writeFileSync(tastePath, authored);
    const parsed = manager.readRules();
    expect(parsed.status.valid).toBe(true);
    expect(parsed.rules.artistWeights.Artist).toBe(1.8);
    expect(parsed.rules.blockedTags).toContain("style:metal");

    const library = JSON.parse(fs.readFileSync(path.join(dir, "library.json"), "utf8")) as {
      recordings: Array<{ tags: Array<{ category: string }> }>;
    };
    expect(library.recordings[0]?.tags.map((tag) => tag.category)).toEqual(["artist", "style"]);
    expect(fs.readFileSync(tastePath, "utf8")).toContain("musicgpt:auto:start");
  });

  it("continues with the last valid manual rules after a syntax error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-taste-invalid-"));
    const manager = new TasteDocumentManager(dir);
    const tastePath = path.join(dir, "taste.md");
    manager.ensureFiles();
    fs.writeFileSync(tastePath, "---\nartistWeights:\n  Artist: 1.5\n---\n<!-- musicgpt:auto:start -->\n<!-- musicgpt:auto:end -->\n");
    expect(manager.readRules().rules.artistWeights.Artist).toBe(1.5);
    fs.writeFileSync(tastePath, "---\nartistWeights: [broken\n---\n");
    const fallback = manager.readRules();
    expect(fallback.status.valid).toBe(false);
    expect(fallback.rules.artistWeights.Artist).toBe(1.5);
  });
});
