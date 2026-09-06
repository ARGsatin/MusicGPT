import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { StateRepository } from "../src/stateRepository.js";

describe("StateRepository v2 source identity migration", () => {
  it("updates playback facts only for a real start or valid completion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-playback-facts-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.upsertTrackStats([
      {
        track: { id: 42, title: "Fact Check", artists: ["A"] },
        playCount: 0
      }
    ]);

    repo.addPlayEvent({ type: "like", trackId: 42, at: "2026-08-25T01:00:00.000Z" });
    repo.addPlayEvent({ type: "skip", trackId: 42, at: "2026-08-25T02:00:00.000Z" });
    expect(repo.getTrackStats()[0]).toMatchObject({ playCount: 0 });
    expect(repo.getTrackStats()[0]?.lastPlayedAt).toBeUndefined();

    repo.addPlayEvent({ type: "play", trackId: 42, at: "2026-08-25T03:00:00.000Z" });
    expect(repo.getTrackStats()[0]?.lastPlayedAt).toBe("2026-08-25T03:00:00.000Z");
    repo.addPlayEvent({ type: "complete", trackId: 42, at: "2026-08-25T03:04:00.000Z" });
    expect(repo.getTrackStats()[0]?.playCount).toBe(1);
    expect(repo.getTrackStats()[0]?.lastPlayedAt).toBe("2026-08-25T03:04:00.000Z");
  });

  it("round-trips QQ track keys and keeps legacy numeric NCM references compatible", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-state-v2-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    repo.upsertTrackStats([
      {
        track: {
          id: "qq-song-003",
          trackKey: "qq:qq-song-003",
          recordingKey: "recording:shared-song",
          source: "qq",
          sourceId: "qq-song-003",
          title: "Shared Song",
          artists: ["Artist"]
        },
        playCount: 1
      },
      {
        track: { id: 123, title: "Legacy Song", artists: ["NCM Artist"] },
        playCount: 2
      }
    ]);
    repo.addPlayEvent({
      type: "complete",
      trackId: "qq:qq-song-003",
      at: "2026-08-15T01:00:00.000Z"
    });

    expect(repo.getTrackStats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          track: expect.objectContaining({
            trackKey: "qq:qq-song-003",
            recordingKey: "recording:shared-song",
            source: "qq"
          })
        }),
        expect.objectContaining({
          track: expect.objectContaining({ trackKey: "ncm:123", source: "ncm", sourceId: "123" })
        })
      ])
    );
    expect(repo.getPlayEventsSince("2026-08-15T00:00:00.000Z")[0]?.trackId).toBe(
      "qq:qq-song-003"
    );
    expect(repo.setTrackFavorite("qq:qq-song-003", true)).toBe(true);
  });

  it("backs up and idempotently upgrades a v1 database while preserving facts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-state-v1-"));
    const dbPath = path.join(dir, "state.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE track_stats (
        track_id INTEGER PRIMARY KEY,
        track_json TEXT NOT NULL,
        liked_at TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at TEXT,
        last_played_hour INTEGER
      );
      CREATE TABLE play_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE recommendation_candidates (
        track_id INTEGER PRIMARY KEY,
        track_json TEXT NOT NULL,
        source TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    legacy.prepare(
      "INSERT INTO track_stats(track_id, track_json, liked_at, play_count) VALUES (?, ?, ?, ?)"
    ).run(
      7,
      JSON.stringify({ id: 7, title: "Legacy", artists: ["Artist"] }),
      "2026-01-01T00:00:00.000Z",
      4
    );
    legacy.prepare(
      "INSERT INTO play_events(track_id, event_type, at, metadata_json) VALUES (?, ?, ?, ?)"
    ).run(7, "like", "2026-02-01T00:00:00.000Z", "{}");
    legacy.prepare(
      "INSERT INTO recommendation_candidates VALUES (?, ?, ?, ?, ?, ?)"
    ).run(8, JSON.stringify({ id: 8, title: "Ephemeral", artists: ["A"] }), "context_search", "[]", "2026-01-01", "2099-01-01");
    legacy.close();

    const first = new StateRepository(dbPath);
    expect(first.getTrackStats()[0]).toMatchObject({
      track: { trackKey: "ncm:7", source: "ncm", sourceId: "7" },
      likedAt: "2026-01-01T00:00:00.000Z",
      localFavoritedAt: "2026-02-01T00:00:00.000Z",
      playCount: 4
    });
    expect(first.getRecentPlayEvents()[0]?.trackId).toBe("ncm:7");
    expect(first.getRecommendationCandidates()).toEqual([]);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("state.db.v1-backup-"))).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.startsWith("state.db.intelligence-backup-"))).toBe(true);

    const second = new StateRepository(dbPath);
    expect(second.getTrackStats()).toHaveLength(1);
    expect(second.getRecentPlayEvents()).toHaveLength(1);
  });

  it("restores the pre-migration database snapshot when an intelligence migration fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-state-restore-"));
    const dbPath = path.join(dir, "state.db");
    const broken = new DatabaseSync(dbPath);
    broken.exec(`
      CREATE TABLE play_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT
      );
      INSERT INTO play_events(track_key, event_type, at) VALUES ('ncm:1', 'play', '2026-08-25T00:00:00.000Z');
    `);
    broken.close();

    expect(() => new StateRepository(dbPath, {
      beforeIntelligenceMigration: () => {
        throw new Error("injected migration failure");
      }
    })).toThrow("injected migration failure");

    const restored = new DatabaseSync(dbPath, { readOnly: true });
    const objects = restored.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all() as Array<{
      type: string;
      name: string;
    }>;
    expect(objects).toEqual(expect.arrayContaining([
      { type: "table", name: "play_events" }
    ]));
    expect(objects.some((entry) => entry.name === "track_stats")).toBe(false);
    expect(restored.prepare("SELECT COUNT(*) AS count FROM play_events").get()).toEqual({ count: 1 });
    restored.close();
    expect(fs.readdirSync(dir).some((name) => name.startsWith("state.db.intelligence-backup-"))).toBe(true);
  });
});
