import fs from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import type {
  DjScript,
  NowPlayingState,
  PlayEvent,
  TasteProfile,
  Track,
  TrackStat
} from "@musicgpt/shared";

interface MessageRecord {
  role: "user" | "assistant";
  text: string;
  at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class StateRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_stats (
        track_id INTEGER PRIMARY KEY,
        track_json TEXT NOT NULL,
        liked_at TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at TEXT,
        last_played_hour INTEGER
      );
      CREATE TABLE IF NOT EXISTS play_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS taste_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        profile_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dj_scripts (
        id TEXT PRIMARY KEY,
        script_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);
  }

  upsertTrackStats(stats: TrackStat[]): void {
    const statement = this.db.prepare(`
      INSERT INTO track_stats(track_id, track_json, liked_at, play_count, last_played_at, last_played_hour)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        track_json=excluded.track_json,
        liked_at=COALESCE(excluded.liked_at, track_stats.liked_at),
        play_count=MAX(track_stats.play_count, excluded.play_count),
        last_played_at=COALESCE(excluded.last_played_at, track_stats.last_played_at),
        last_played_hour=COALESCE(excluded.last_played_hour, track_stats.last_played_hour);
    `);

    this.db.exec("BEGIN");
    try {
      for (const row of stats) {
        statement.run(
          row.track.id,
          JSON.stringify(row.track),
          row.likedAt ?? null,
          row.playCount,
          row.lastPlayedAt ?? null,
          row.lastPlayedHour ?? null
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTrackStats(limit = 800): TrackStat[] {
    const stmt = this.db.prepare(`
      SELECT track_json, liked_at, play_count, last_played_at, last_played_hour
      FROM track_stats
      ORDER BY play_count DESC, track_id DESC
      LIMIT ?;
    `);
    const rows = stmt.all(limit) as Array<{
      track_json: string;
      liked_at: string | null;
      play_count: number;
      last_played_at: string | null;
      last_played_hour: number | null;
    }>;

    return rows.map((row) => {
      const stat: TrackStat = {
        track: parseJson<Track>(row.track_json, {
          id: 0,
          title: "unknown",
          artists: ["unknown"]
        }),
        playCount: row.play_count
      };
      if (row.liked_at) {
        stat.likedAt = row.liked_at;
      }
      if (row.last_played_at) {
        stat.lastPlayedAt = row.last_played_at;
      }
      if (typeof row.last_played_hour === "number") {
        stat.lastPlayedHour = row.last_played_hour;
      }
      return stat;
    });
  }

  patchTrackSongUrl(trackId: number, songUrl: string): void {
    const row = this.db
      .prepare("SELECT track_json FROM track_stats WHERE track_id = ?")
      .get(trackId) as { track_json: string } | undefined;
    if (!row) {
      return;
    }
    const parsed = parseJson<Track>(row.track_json, {
      id: trackId,
      title: "",
      artists: []
    });
    parsed.songUrl = songUrl;
    this.db
      .prepare("UPDATE track_stats SET track_json = ? WHERE track_id = ?")
      .run(JSON.stringify(parsed), trackId);
  }

  addPlayEvent(event: PlayEvent): void {
    this.db
      .prepare(
        "INSERT INTO play_events(track_id, event_type, at, metadata_json) VALUES (?, ?, ?, ?)"
      )
      .run(event.trackId, event.type, event.at, JSON.stringify(event.metadata ?? {}));

    const hour = new Date(event.at).getHours();
    this.db
      .prepare(
        "UPDATE track_stats SET last_played_at = ?, last_played_hour = ?, play_count = play_count + ? WHERE track_id = ?"
      )
      .run(event.at, hour, event.type === "complete" || event.type === "replay" ? 1 : 0, event.trackId);
  }

  getRecentPlayEvents(limit = 120): PlayEvent[] {
    const rows = this.db
      .prepare(
        "SELECT track_id, event_type, at, metadata_json FROM play_events ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as Array<{
      track_id: number;
      event_type: PlayEvent["type"];
      at: string;
      metadata_json: string | null;
    }>;

    return rows.map((row) => ({
      trackId: row.track_id,
      type: row.event_type,
      at: row.at,
      metadata: parseJson(row.metadata_json, {})
    }));
  }

  saveTasteProfile(profile: TasteProfile): void {
    this.db
      .prepare(
        "INSERT INTO taste_profile(id, profile_json, updated_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at"
      )
      .run(JSON.stringify(profile), profile.generatedAt);
  }

  getTasteProfile(): TasteProfile | undefined {
    const row = this.db
      .prepare("SELECT profile_json FROM taste_profile WHERE id = 1")
      .get() as { profile_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return parseJson<TasteProfile | undefined>(row.profile_json, undefined);
  }

  saveNowPlaying(state: NowPlayingState): void {
    this.db
      .prepare(
        "INSERT INTO app_state(key, value_json) VALUES('now_playing', ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"
      )
      .run(JSON.stringify(state));
  }

  getNowPlaying(): NowPlayingState | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM app_state WHERE key = 'now_playing'")
      .get() as { value_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return parseJson<NowPlayingState | undefined>(row.value_json, undefined);
  }

  saveDjScript(script: DjScript): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO dj_scripts(id, script_json, created_at) VALUES(?, ?, ?)"
      )
      .run(script.id, JSON.stringify(script), script.createdAt);
  }

  getLatestDjScript(): DjScript | undefined {
    const row = this.db
      .prepare("SELECT script_json FROM dj_scripts ORDER BY created_at DESC LIMIT 1")
      .get() as { script_json: string } | undefined;
    return row ? parseJson<DjScript | undefined>(row.script_json, undefined) : undefined;
  }

  addChatMessage(message: MessageRecord): void {
    this.db
      .prepare("INSERT INTO chat_messages(role, text, at) VALUES(?, ?, ?)")
      .run(message.role, message.text, message.at);
  }

  getRecentMessages(limit = 30): MessageRecord[] {
    const rows = this.db
      .prepare("SELECT role, text, at FROM chat_messages ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as MessageRecord[];
    return rows.slice().reverse();
  }
}
