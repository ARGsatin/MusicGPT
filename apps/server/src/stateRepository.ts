import fs from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import type {
  ChatMemory,
  ChatMemoryCategory,
  ChatMessage,
  ChatSpeech,
  DjSettings,
  DjScript,
  EnvironmentContext,
  NowPlayingState,
  PlayEvent,
  RecommendationCandidate,
  RecommendationSource,
  TasteProfile,
  Track,
  TrackStat
} from "@musicgpt/shared";

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
        local_favorited_at TEXT,
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
        at TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recommendation_candidates (
        track_id INTEGER PRIMARY KEY,
        track_json TEXT NOT NULL,
        source TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.ensureChatMetadataColumn();
    this.ensureTrackStatsColumns();
    this.migrateLegacyLocalFavorites();
  }

  private ensureTrackStatsColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(track_stats)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "local_favorited_at")) {
      this.db.exec("ALTER TABLE track_stats ADD COLUMN local_favorited_at TEXT");
    }
  }

  private migrateLegacyLocalFavorites(): void {
    this.db.exec(`
      UPDATE track_stats
      SET local_favorited_at = (
        SELECT MAX(play_events.at)
        FROM play_events
        WHERE play_events.track_id = track_stats.track_id
          AND play_events.event_type = 'like'
      )
      WHERE local_favorited_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM play_events
          WHERE play_events.track_id = track_stats.track_id
            AND play_events.event_type = 'like'
        );
    `);
  }

  private ensureChatMetadataColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT");
    }
  }

  upsertTrackStats(stats: TrackStat[]): void {
    const statement = this.db.prepare(`
      INSERT INTO track_stats(
        track_id, track_json, liked_at, local_favorited_at, play_count, last_played_at, last_played_hour
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        track_json=excluded.track_json,
        liked_at=COALESCE(excluded.liked_at, track_stats.liked_at),
        local_favorited_at=COALESCE(excluded.local_favorited_at, track_stats.local_favorited_at),
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
          row.localFavoritedAt ?? null,
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
           , local_favorited_at
      FROM track_stats
      ORDER BY (local_favorited_at IS NOT NULL) DESC, play_count DESC, track_id DESC
      LIMIT ?;
    `);
    const rows = stmt.all(limit) as Array<{
      track_json: string;
      liked_at: string | null;
      local_favorited_at: string | null;
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
      if (row.local_favorited_at) {
        stat.localFavoritedAt = row.local_favorited_at;
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

  getTrackStatsCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM track_stats")
      .get() as { count: number };
    return row.count;
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

  ensureTrack(track: Track): void {
    const existing = this.db
      .prepare("SELECT track_id FROM track_stats WHERE track_id = ?")
      .get(track.id) as { track_id: number } | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE track_stats SET track_json = ? WHERE track_id = ?")
        .run(JSON.stringify(track), track.id);
      return;
    }
    this.upsertTrackStats([{ track, playCount: 0 }]);
  }

  markTrackLiked(trackId: number, likedAt: string): void {
    this.setTrackFavorite(trackId, true, likedAt);
  }

  setTrackFavorite(trackId: number, favorite: boolean, at = new Date().toISOString()): boolean {
    this.db
      .prepare("UPDATE track_stats SET local_favorited_at = ? WHERE track_id = ?")
      .run(favorite ? at : null, trackId);
    return this.isTrackFavorite(trackId);
  }

  isTrackFavorite(trackId: number): boolean {
    const row = this.db
      .prepare("SELECT local_favorited_at FROM track_stats WHERE track_id = ?")
      .get(trackId) as { local_favorited_at: string | null } | undefined;
    return Boolean(row?.local_favorited_at);
  }

  upsertRecommendationCandidates(candidates: RecommendationCandidate[]): void {
    if (candidates.length === 0) {
      return;
    }
    const statement = this.db.prepare(`
      INSERT INTO recommendation_candidates(
        track_id, track_json, source, tags_json, discovered_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_id) DO UPDATE SET
        track_json=excluded.track_json,
        source=excluded.source,
        tags_json=excluded.tags_json,
        discovered_at=excluded.discovered_at,
        expires_at=excluded.expires_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const candidate of candidates) {
        statement.run(
          candidate.track.id,
          JSON.stringify({ ...candidate.track, tags: candidate.tags }),
          candidate.source,
          JSON.stringify(candidate.tags),
          candidate.discoveredAt,
          candidate.expiresAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRecommendationCandidates(
    limit = 1000,
    now = new Date().toISOString()
  ): RecommendationCandidate[] {
    const rows = this.db
      .prepare(`
        SELECT track_json, source, tags_json, discovered_at, expires_at
        FROM recommendation_candidates
        WHERE expires_at > ?
        ORDER BY discovered_at DESC, track_id DESC
        LIMIT ?
      `)
      .all(now, limit) as Array<{
      track_json: string;
      source: RecommendationSource;
      tags_json: string;
      discovered_at: string;
      expires_at: string;
    }>;
    return rows.map((row) => ({
      track: parseJson<Track>(row.track_json, { id: 0, title: "unknown", artists: ["unknown"] }),
      source: row.source,
      tags: parseJson(row.tags_json, []),
      discoveredAt: row.discovered_at,
      expiresAt: row.expires_at
    }));
  }

  deleteExpiredRecommendationCandidates(now = new Date().toISOString()): void {
    this.db.prepare("DELETE FROM recommendation_candidates WHERE expires_at <= ?").run(now);
  }

  saveRecommendationRefreshDate(source: RecommendationSource, date: string): void {
    this.saveAppState(`recommendation_refresh:${source}`, date);
  }

  getRecommendationRefreshDate(source: RecommendationSource): string | undefined {
    return this.getAppState<string>(`recommendation_refresh:${source}`);
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
    this.saveAppState("now_playing", state);
  }

  getNowPlaying(): NowPlayingState | undefined {
    return this.getAppState<NowPlayingState>("now_playing");
  }

  saveEnvironmentContext(context: EnvironmentContext): void {
    this.saveAppState("environment", context);
  }

  getEnvironmentContext(): EnvironmentContext | undefined {
    return this.getAppState<EnvironmentContext>("environment");
  }

  saveDjSettings(settings: DjSettings): void {
    this.saveAppState("dj_settings", settings);
  }

  getDjSettings(): DjSettings | undefined {
    return this.getAppState<DjSettings>("dj_settings");
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

  addChatMessage(message: ChatMessage): ChatMessage {
    const result = this.db
      .prepare("INSERT INTO chat_messages(role, text, at, metadata_json) VALUES(?, ?, ?, ?)")
      .run(
        message.role,
        message.text,
        message.at,
        JSON.stringify({
          trackSuggestion: message.trackSuggestion,
          speech: message.speech
        })
      );
    return { ...message, id: Number(result.lastInsertRowid) };
  }

  getRecentMessages(limit = 30): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT id, role, text, at, metadata_json FROM chat_messages ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{
        id: number;
        role: ChatMessage["role"];
        text: string;
        at: string;
        metadata_json?: string | null;
      }>;
    return rows
      .slice()
      .reverse()
      .map((row) => this.mapChatMessage(row));
  }

  getChatMessage(id: number): ChatMessage | undefined {
    const row = this.db
      .prepare("SELECT id, role, text, at, metadata_json FROM chat_messages WHERE id = ?")
      .get(id) as
      | {
          id: number;
          role: ChatMessage["role"];
          text: string;
          at: string;
          metadata_json?: string | null;
        }
      | undefined;
    return row ? this.mapChatMessage(row) : undefined;
  }

  saveChatSpeech(id: number, speech: ChatSpeech): ChatMessage | undefined {
    const message = this.getChatMessage(id);
    if (!message) {
      return undefined;
    }
    const metadata = {
      trackSuggestion: message.trackSuggestion,
      speech
    };
    this.db.prepare("UPDATE chat_messages SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
    return { ...message, speech };
  }

  clearChatMessages(): void {
    this.db.prepare("DELETE FROM chat_messages").run();
  }

  upsertChatMemory(input: {
    category: ChatMemoryCategory;
    content: string;
    normalizedKey: string;
    at?: string;
  }): ChatMemory {
    const at = input.at ?? new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO chat_memories(category, content, normalized_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(normalized_key) DO UPDATE SET
          category=excluded.category,
          content=excluded.content,
          updated_at=excluded.updated_at
      `)
      .run(input.category, input.content, input.normalizedKey, at, at);
    const row = this.db
      .prepare(`
        SELECT id, category, content, created_at, updated_at
        FROM chat_memories
        WHERE normalized_key = ?
      `)
      .get(input.normalizedKey) as unknown as ChatMemoryRow;
    return mapChatMemory(row);
  }

  getChatMemories(limit = 100): ChatMemory[] {
    const rows = this.db
      .prepare(`
        SELECT id, category, content, created_at, updated_at
        FROM chat_memories
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit) as unknown as ChatMemoryRow[];
    return rows.map(mapChatMemory);
  }

  deleteChatMemory(id: number): boolean {
    const result = this.db.prepare("DELETE FROM chat_memories WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  deleteChatMemories(ids: number[]): number {
    const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) {
      return 0;
    }
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM chat_memories WHERE id IN (${placeholders})`)
      .run(...uniqueIds);
    return Number(result.changes);
  }

  clearChatMemories(): void {
    this.db.prepare("DELETE FROM chat_memories").run();
  }

  pruneChatMemories(maxItems = 100): void {
    const limit = Math.max(1, Math.floor(maxItems));
    this.db.prepare(`
      DELETE FROM chat_memories
      WHERE id NOT IN (
        SELECT id
        FROM chat_memories
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      )
    `).run(limit);
  }

  private mapChatMessage(row: {
    id: number;
    role: ChatMessage["role"];
    text: string;
    at: string;
    metadata_json?: string | null;
  }): ChatMessage {
    const metadata = parseJson<{
      trackSuggestion?: ChatMessage["trackSuggestion"];
      speech?: ChatSpeech;
    }>(row.metadata_json ?? null, {});
    const message: ChatMessage = {
      id: row.id,
      role: row.role,
      text: row.text,
      at: row.at
    };
    if (metadata.trackSuggestion) {
      message.trackSuggestion = metadata.trackSuggestion;
    }
    if (metadata.speech) {
      message.speech = metadata.speech;
    }
    return message;
  }

  private saveAppState<T>(key: string, value: T): void {
    this.db
      .prepare(
        "INSERT INTO app_state(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"
      )
      .run(key, JSON.stringify(value));
  }

  private getAppState<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM app_state WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return parseJson<T | undefined>(row.value_json, undefined);
  }
}

interface ChatMemoryRow {
  id: number;
  category: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function mapChatMemory(row: ChatMemoryRow): ChatMemory {
  return {
    id: row.id,
    category: row.category as ChatMemoryCategory,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
