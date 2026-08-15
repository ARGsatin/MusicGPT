import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { StateRepository } from "../src/stateRepository.js";

describe("recommendation state migration", () => {
  it("adds local favorite state and restores legacy heart events without changing NCM liked_at", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-state-migration-"));
    const dbPath = path.join(tmp, "state.db");
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
    `);
    legacy.prepare(`
      INSERT INTO track_stats(track_id, track_json, liked_at, play_count)
      VALUES (?, ?, ?, ?)
    `).run(
      7,
      JSON.stringify({ id: 7, title: "Legacy Heart", artists: ["A"] }),
      "2025-01-01T00:00:00.000Z",
      3
    );
    legacy.prepare(`
      INSERT INTO play_events(track_id, event_type, at, metadata_json)
      VALUES (?, 'like', ?, '{}')
    `).run(7, "2026-07-01T12:00:00.000Z");
    legacy.close();

    const repo = new StateRepository(dbPath);
    const stat = repo.getTrackStats().find((item) => item.track.id === 7);

    expect(stat?.likedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(stat?.localFavoritedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("round-trips expiring recommendation candidates separately from listening stats", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-candidate-state-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    repo.upsertRecommendationCandidates([
      {
        track: { id: 88, title: "New Territory", artists: ["Explorer"] },
        source: "ncm_daily",
        tags: [{ category: "style", value: "爵士" }],
        relevanceScore: 0.9,
        discoveredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    ]);

    expect(repo.getTrackStats()).toHaveLength(0);
    expect(repo.getRecommendationCandidates()).toEqual([
      expect.objectContaining({
        track: expect.objectContaining({ id: 88 }),
        source: "ncm_daily",
        tags: [{ category: "style", value: "爵士" }],
        relevanceScore: 0.9
      })
    ]);
  });

  it("rebuilds legacy recommendation candidates during the v2 identity migration", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-candidate-migration-"));
    const dbPath = path.join(tmp, "state.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE recommendation_candidates (
        track_id INTEGER PRIMARY KEY,
        track_json TEXT NOT NULL,
        source TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO recommendation_candidates(
        track_id, track_json, source, tags_json, discovered_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      99,
      JSON.stringify({ id: 99, title: "Legacy Candidate", artists: ["A"] }),
      "context_search",
      "[]",
      "2026-08-01T00:00:00.000Z",
      "2099-08-02T00:00:00.000Z"
    );
    legacy.close();

    const repo = new StateRepository(dbPath);

    expect(repo.getRecommendationCandidates()).toEqual([]);
  });

  it("reads all feedback in the requested time window rather than a fixed row limit", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-feedback-window-"));
    const repo = new StateRepository(path.join(tmp, "state.db"));
    const now = Date.now();
    for (let index = 0; index < 150; index += 1) {
      repo.addPlayEvent({
        type: "skip",
        trackId: index + 1,
        at: new Date(now - index * 1_000).toISOString()
      });
    }
    repo.addPlayEvent({
      type: "skip",
      trackId: 999,
      at: new Date(now - 100 * 24 * 60 * 60 * 1_000).toISOString()
    });

    const recent = repo.getPlayEventsSince(
      new Date(now - 90 * 24 * 60 * 60 * 1_000).toISOString()
    );

    expect(recent).toHaveLength(150);
    expect(recent.some((event) => event.trackId === 999)).toBe(false);
  });
});
