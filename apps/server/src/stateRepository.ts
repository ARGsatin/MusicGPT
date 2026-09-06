import fs from "node:fs";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import type {
  ChatMemory,
  ChatMemoryCategory,
  ChatMessage,
  DjSettings,
  DjScript,
  EnvironmentContext,
  LibraryEvidence,
  DailyPlan,
  NowPlayingState,
  PlaybackOutcomeRequest,
  PlayEvent,
  RecommendationCandidate,
  RecommendationSource,
  TasteProfile,
  Track,
  TrackReference,
  TrackStat,
  SessionIntent
} from "@musicgpt/shared";

import {
  getTrackKey,
  normalizeTrackIdentity,
  normalizeTrackReference
} from "./musicCatalog.js";
import type { IntelligencePolicyState } from "./intelligencePolicy.js";
import type {
  LearningReceipt as PolicyLearningReceipt,
  ListeningObservation,
  ListeningPolicyState,
  PreferenceSignal,
  RankedDecision
} from "./listeningPolicy.js";

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
  private db: DatabaseSync;
  private migratedToV2 = false;

  constructor(
    readonly dbPath: string,
    private readonly options: { beforeIntelligenceMigration?: () => void } = {}
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    const legacyBackup = this.backupLegacyDatabase(dbPath);
    const intelligenceBackup = this.backupIntelligenceDatabase(dbPath);
    try {
      this.bootstrap();
    } catch (error) {
      this.db.close();
      const restoreFrom = intelligenceBackup ?? legacyBackup;
      if (restoreFrom && dbPath !== ":memory:") {
        for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
          if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
        }
        fs.copyFileSync(restoreFrom, dbPath);
      }
      throw error;
    }
  }

  private backupLegacyDatabase(dbPath: string): string | undefined {
    if (dbPath === ":memory:" || !fs.existsSync(dbPath) || !this.hasLegacyTrackIdentitySchema()) {
      return;
    }
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = `${dbPath}.v1-backup-${stamp}`;
    // VACUUM INTO uses SQLite's own snapshot machinery, so the backup stays
    // consistent even when the source database uses a journal or WAL file.
    this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    return backupPath;
  }

  private hasLegacyTrackIdentitySchema(): boolean {
    return ["track_stats", "play_events", "recommendation_candidates"].some((table) => {
      const exists = this.db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { found: number } | undefined;
      if (!exists) return false;
      const columns = this.tableColumns(table);
      return columns.includes("track_id") && !columns.includes("track_key");
    });
  }

  private backupIntelligenceDatabase(dbPath: string): string | undefined {
    if (dbPath === ":memory:" || !fs.existsSync(dbPath) || !this.needsIntelligenceMigration()) {
      return undefined;
    }
    const stamp = new Date().toISOString().replaceAll(":", "-");
    const backupPath = `${dbPath}.intelligence-backup-${stamp}`;
    this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    return backupPath;
  }

  private needsIntelligenceMigration(): boolean {
    const playEvents = this.db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'play_events'")
      .get() as { found: number } | undefined;
    if (!playEvents) return false;
    const eventColumns = this.tableColumns("play_events");
    const signals = this.db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'preference_signals'")
      .get() as { found: number } | undefined;
    return !eventColumns.includes("playback_id") || !signals;
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_stats (
        track_key TEXT PRIMARY KEY,
        recording_key TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        liked_at TEXT,
        local_favorited_at TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        last_played_at TEXT,
        last_played_hour INTEGER
      );
      CREATE TABLE IF NOT EXISTS play_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT,
        event_id TEXT,
        recording_key TEXT,
        source TEXT,
        reason TEXT,
        scope TEXT,
        playback_id TEXT,
        decision_id TEXT,
        listened_ms INTEGER,
        duration_ms INTEGER,
        turn_id TEXT,
        session_id TEXT,
        context_json TEXT
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
        metadata_json TEXT,
        turn_id TEXT,
        source TEXT NOT NULL DEFAULT 'text',
        status TEXT NOT NULL DEFAULT 'completed',
        model TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS conversation_tool_calls (
        command_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
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
        track_key TEXT PRIMARY KEY,
        track_json TEXT NOT NULL,
        source TEXT NOT NULL,
        provider TEXT,
        discovery TEXT,
        tags_json TEXT NOT NULL,
        relevance_score REAL NOT NULL DEFAULT 0.5,
        discovered_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recordings (
        recording_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artists_json TEXT NOT NULL,
        duration_ms INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_tracks (
        track_key TEXT PRIMARY KEY,
        recording_key TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        track_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS track_tag_evidence (
        track_key TEXT NOT NULL,
        category TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(track_key, category, value, source)
      );
      CREATE TABLE IF NOT EXISTS library_evidence (
        track_key TEXT NOT NULL,
        recording_key TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        container_id TEXT NOT NULL DEFAULT '',
        container_name TEXT,
        play_count INTEGER,
        PRIMARY KEY(track_key, kind, observed_at, container_id)
      );
    `);
    this.migrateSourceIdentityTables();
    this.options.beforeIntelligenceMigration?.();
    this.ensureIntelligenceSchema();
    this.ensureChatMetadataColumn();
    this.ensureConversationColumns();
    this.ensureConversationRevision();
    this.ensureTrackStatsColumns();
    this.ensureRecommendationCandidateColumns();
    this.migrateLegacyLocalFavorites();
    this.backfillCatalogTracks();
    if (this.migratedToV2) this.clearExpiredConfirmationCache();
  }

  private tableColumns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    );
  }

  private migrateSourceIdentityTables(): void {
    const trackColumns = this.tableColumns("track_stats");
    const eventColumns = this.tableColumns("play_events");
    const candidateColumns = this.tableColumns("recommendation_candidates");
    if (
      !trackColumns.includes("track_id") &&
      !eventColumns.includes("track_id") &&
      !candidateColumns.includes("track_id")
    ) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (trackColumns.includes("track_id")) {
        const legacyRows = this.db.prepare("SELECT * FROM track_stats").all() as Array<{
          track_id: number;
          track_json: string;
          liked_at?: string | null;
          local_favorited_at?: string | null;
          play_count?: number;
          last_played_at?: string | null;
          last_played_hour?: number | null;
        }>;
        const favoriteRows = eventColumns.includes("track_id")
          ? (this.db
              .prepare(
                "SELECT track_id, MAX(at) AS at FROM play_events WHERE event_type = 'like' GROUP BY track_id"
              )
              .all() as Array<{ track_id: number; at: string }>)
          : [];
        const favorites = new Map(favoriteRows.map((row) => [row.track_id, row.at]));
        this.db.exec(`
          ALTER TABLE track_stats RENAME TO track_stats_v1;
          CREATE TABLE track_stats (
            track_key TEXT PRIMARY KEY,
            recording_key TEXT NOT NULL,
            source TEXT NOT NULL,
            source_id TEXT NOT NULL,
            track_json TEXT NOT NULL,
            liked_at TEXT,
            local_favorited_at TEXT,
            play_count INTEGER NOT NULL DEFAULT 0,
            last_played_at TEXT,
            last_played_hour INTEGER
          );
        `);
        const insert = this.db.prepare(`
          INSERT INTO track_stats(
            track_key, recording_key, source, source_id, track_json, liked_at,
            local_favorited_at, play_count, last_played_at, last_played_hour
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of legacyRows) {
          const track = normalizeTrackIdentity(
            parseJson<Track>(row.track_json, {
              id: row.track_id,
              title: "unknown",
              artists: ["unknown"]
            })
          );
          insert.run(
            track.trackKey!,
            track.recordingKey!,
            track.source!,
            track.sourceId!,
            JSON.stringify(track),
            row.liked_at ?? null,
            row.local_favorited_at ?? favorites.get(row.track_id) ?? null,
            row.play_count ?? 0,
            row.last_played_at ?? null,
            row.last_played_hour ?? null
          );
        }
        this.db.exec("DROP TABLE track_stats_v1");
      }

      if (eventColumns.includes("track_id")) {
        this.db.exec(`
          ALTER TABLE play_events RENAME TO play_events_v1;
          CREATE TABLE play_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            track_key TEXT NOT NULL,
            event_type TEXT NOT NULL,
            at TEXT NOT NULL,
            metadata_json TEXT
          );
          INSERT INTO play_events(id, track_key, event_type, at, metadata_json)
          SELECT id, 'ncm:' || track_id, event_type, at, metadata_json
          FROM play_events_v1;
          DROP TABLE play_events_v1;
        `);
      }

      if (candidateColumns.includes("track_id")) {
        this.db.exec(`
          DROP TABLE recommendation_candidates;
          CREATE TABLE recommendation_candidates (
            track_key TEXT PRIMARY KEY,
            track_json TEXT NOT NULL,
            source TEXT NOT NULL,
            provider TEXT,
            discovery TEXT,
            tags_json TEXT NOT NULL,
            relevance_score REAL NOT NULL DEFAULT 0.5,
            discovered_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
        `);
      }
      this.db.prepare("DELETE FROM app_state WHERE key = 'now_playing'").run();
      this.db.prepare("DELETE FROM app_state WHERE key LIKE 'recommendation_refresh:%'").run();
      this.db.exec("COMMIT");
      this.migratedToV2 = true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillCatalogTracks(): void {
    const rows = this.db.prepare("SELECT track_json FROM track_stats").all() as Array<{ track_json: string }>;
    for (const row of rows) {
      const track = normalizeTrackIdentity(parseJson<Track>(row.track_json, {
        id: 0,
        title: "unknown",
        artists: ["unknown"]
      }));
      this.upsertCatalogTrack(track);
    }
  }

  private clearExpiredConfirmationCache(): void {
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    this.db.prepare(
      "DELETE FROM conversation_tool_calls WHERE consumed_at IS NOT NULL OR created_at < ?"
    ).run(cutoff);
  }

  private ensureTrackStatsColumns(): void {
    const columns = this.tableColumns("track_stats");
    if (!columns.includes("local_favorited_at")) {
      this.db.exec("ALTER TABLE track_stats ADD COLUMN local_favorited_at TEXT");
    }
  }

  private ensureRecommendationCandidateColumns(): void {
    const columns = this.tableColumns("recommendation_candidates");
    if (!columns.includes("relevance_score")) {
      this.db.exec("ALTER TABLE recommendation_candidates ADD COLUMN relevance_score REAL NOT NULL DEFAULT 0.5");
    }
    if (!columns.includes("provider")) {
      this.db.exec("ALTER TABLE recommendation_candidates ADD COLUMN provider TEXT");
    }
    if (!columns.includes("discovery")) {
      this.db.exec("ALTER TABLE recommendation_candidates ADD COLUMN discovery TEXT");
    }
  }

  private migrateLegacyLocalFavorites(): void {
    this.db.exec(`
      UPDATE track_stats
      SET local_favorited_at = (
        SELECT MAX(play_events.at)
        FROM play_events
        WHERE play_events.track_key = track_stats.track_key
          AND play_events.event_type = 'like'
      )
      WHERE local_favorited_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM play_events
          WHERE play_events.track_key = track_stats.track_key
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

  private ensureConversationColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    const additions: Array<[string, string]> = [
      ["turn_id", "TEXT"],
      ["source", "TEXT NOT NULL DEFAULT 'text'"],
      ["status", "TEXT NOT NULL DEFAULT 'completed'"],
      ["model", "TEXT"],
      ["session_id", "TEXT"]
    ];
    for (const [name, type] of additions) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE chat_messages ADD COLUMN ${name} ${type}`);
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_turn_role
      ON chat_messages(turn_id, role)
      WHERE turn_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS conversation_tool_calls (
        command_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
    `);
  }

  private ensureConversationRevision(): void {
    if (this.getAppState<number>("conversation_revision") !== undefined) return;
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS revision FROM chat_messages").get() as {
      revision: number;
    };
    this.saveAppState("conversation_revision", row.revision);
  }

  upsertTrackStats(stats: TrackStat[]): void {
    const statement = this.db.prepare(`
      INSERT INTO track_stats(
        track_key, recording_key, source, source_id, track_json, liked_at,
        local_favorited_at, play_count, last_played_at, last_played_hour
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key) DO UPDATE SET
        recording_key=excluded.recording_key,
        source=excluded.source,
        source_id=excluded.source_id,
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
        const track = normalizeTrackIdentity(row.track);
        statement.run(
          track.trackKey!,
          track.recordingKey!,
          track.source!,
          track.sourceId!,
          JSON.stringify(track),
          row.likedAt ?? null,
          row.localFavoritedAt ?? null,
          row.playCount,
          row.lastPlayedAt ?? null,
          row.lastPlayedHour ?? null
        );
        this.upsertCatalogTrack(track);
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
      ORDER BY (local_favorited_at IS NOT NULL) DESC, play_count DESC, track_key DESC
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
        track: normalizeTrackIdentity(parseJson<Track>(row.track_json, {
          id: 0,
          title: "unknown",
          artists: ["unknown"]
        })),
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

  patchTrackSongUrl(trackId: TrackReference, songUrl: string): void {
    const trackKey = normalizeTrackReference(trackId);
    const row = this.db
      .prepare("SELECT track_json FROM track_stats WHERE track_key = ?")
      .get(trackKey) as { track_json: string } | undefined;
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
      .prepare("UPDATE track_stats SET track_json = ? WHERE track_key = ?")
      .run(JSON.stringify(normalizeTrackIdentity(parsed)), trackKey);
  }

  ensureTrack(track: Track): void {
    const normalized = normalizeTrackIdentity(track);
    const existing = this.db
      .prepare("SELECT track_key FROM track_stats WHERE track_key = ?")
      .get(normalized.trackKey!) as { track_key: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE track_stats SET recording_key = ?, source = ?, source_id = ?, track_json = ? WHERE track_key = ?"
        )
        .run(
          normalized.recordingKey!,
          normalized.source!,
          normalized.sourceId!,
          JSON.stringify(normalized),
          normalized.trackKey!
        );
      return;
    }
    this.upsertTrackStats([{ track: normalized, playCount: 0 }]);
  }

  upsertLibraryEvidence(items: LibraryEvidence[]): void {
    const statement = this.db.prepare(`
      INSERT INTO library_evidence(
        track_key, recording_key, source, kind, observed_at, container_id, container_name, play_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key, kind, observed_at, container_id) DO UPDATE SET
        recording_key=excluded.recording_key,
        container_name=excluded.container_name,
        play_count=excluded.play_count
    `);
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        statement.run(
          item.trackKey,
          item.recordingKey,
          item.source,
          item.kind,
          item.observedAt,
          item.containerId ?? "",
          item.containerName ?? null,
          item.playCount ?? null
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getLibraryEvidence(): LibraryEvidence[] {
    const rows = this.db.prepare(`
      SELECT track_key, recording_key, source, kind, observed_at, container_id, container_name, play_count
      FROM library_evidence ORDER BY observed_at DESC
    `).all() as Array<{
      track_key: string;
      recording_key: string;
      source: LibraryEvidence["source"];
      kind: LibraryEvidence["kind"];
      observed_at: string;
      container_id: string;
      container_name: string | null;
      play_count: number | null;
    }>;
    return rows.map((row) => ({
      trackKey: row.track_key,
      recordingKey: row.recording_key,
      source: row.source,
      kind: row.kind,
      observedAt: row.observed_at,
      ...(row.container_id ? { containerId: row.container_id } : {}),
      ...(row.container_name ? { containerName: row.container_name } : {}),
      ...(row.play_count !== null ? { playCount: row.play_count } : {})
    }));
  }

  private upsertCatalogTrack(track: Track): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO recordings(recording_key, title, artists_json, duration_ms, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(recording_key) DO UPDATE SET
        title=excluded.title,
        artists_json=excluded.artists_json,
        duration_ms=COALESCE(excluded.duration_ms, recordings.duration_ms),
        updated_at=excluded.updated_at
    `).run(
      track.recordingKey!,
      track.title,
      JSON.stringify(track.artists),
      track.durationMs ?? null,
      now
    );
    this.db.prepare(`
      INSERT INTO source_tracks(track_key, recording_key, source, source_id, track_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key) DO UPDATE SET
        recording_key=excluded.recording_key,
        track_json=excluded.track_json,
        updated_at=excluded.updated_at
    `).run(
      track.trackKey!,
      track.recordingKey!,
      track.source!,
      track.sourceId!,
      JSON.stringify(track),
      now
    );
    const tagStatement = this.db.prepare(`
      INSERT INTO track_tag_evidence(track_key, category, value, source, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key, category, value, source) DO UPDATE SET
        confidence=excluded.confidence,
        updated_at=excluded.updated_at
    `);
    for (const tag of track.tagEvidence ?? []) {
      tagStatement.run(track.trackKey!, tag.category, tag.value, tag.source, tag.confidence, now);
    }
  }

  markTrackLiked(trackId: TrackReference, likedAt: string): void {
    this.setTrackFavorite(trackId, true, likedAt);
  }

  setTrackFavorite(trackId: TrackReference, favorite: boolean, at = new Date().toISOString()): boolean {
    const trackKey = normalizeTrackReference(trackId);
    this.db
      .prepare("UPDATE track_stats SET local_favorited_at = ? WHERE track_key = ?")
      .run(favorite ? at : null, trackKey);
    return this.isTrackFavorite(trackKey);
  }

  isTrackFavorite(trackId: TrackReference): boolean {
    const trackKey = normalizeTrackReference(trackId);
    const row = this.db
      .prepare("SELECT local_favorited_at FROM track_stats WHERE track_key = ?")
      .get(trackKey) as { local_favorited_at: string | null } | undefined;
    return Boolean(row?.local_favorited_at);
  }

  upsertRecommendationCandidates(candidates: RecommendationCandidate[]): void {
    if (candidates.length === 0) {
      return;
    }
    const statement = this.db.prepare(`
      INSERT INTO recommendation_candidates(
        track_key, track_json, source, provider, discovery, tags_json, relevance_score, discovered_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key) DO UPDATE SET
        track_json=excluded.track_json,
        source=excluded.source,
        provider=excluded.provider,
        discovery=excluded.discovery,
        tags_json=excluded.tags_json,
        relevance_score=excluded.relevance_score,
        discovered_at=excluded.discovered_at,
        expires_at=excluded.expires_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const candidate of candidates) {
        const track = normalizeTrackIdentity(candidate.track, candidate.provider ?? "ncm");
        statement.run(
          getTrackKey(track),
          JSON.stringify({ ...track, tags: candidate.tags }),
          candidate.source,
          candidate.provider ?? track.source ?? null,
          candidate.discovery ?? null,
          JSON.stringify(candidate.tags),
          candidate.relevanceScore,
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
        SELECT track_json, source, provider, discovery, tags_json, relevance_score, discovered_at, expires_at
        FROM recommendation_candidates
        WHERE expires_at > ?
        ORDER BY discovered_at DESC, relevance_score DESC, track_key DESC
        LIMIT ?
      `)
      .all(now, limit) as Array<{
      track_json: string;
      source: RecommendationSource;
      provider: Track["source"] | null;
      discovery: RecommendationCandidate["discovery"] | null;
      tags_json: string;
      relevance_score: number;
      discovered_at: string;
      expires_at: string;
    }>;
    return rows.map((row) => ({
      track: normalizeTrackIdentity(
        parseJson<Track>(row.track_json, { id: 0, title: "unknown", artists: ["unknown"] }),
        row.provider ?? "ncm"
      ),
      source: row.source,
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.discovery ? { discovery: row.discovery } : {}),
      tags: parseJson(row.tags_json, []),
      relevanceScore: row.relevance_score,
      discoveredAt: row.discovered_at,
      expiresAt: row.expires_at
    }));
  }

  deleteExpiredRecommendationCandidates(now = new Date().toISOString()): void {
    this.db.prepare("DELETE FROM recommendation_candidates WHERE expires_at <= ?").run(now);
  }

  clearRecommendationCandidates(): void {
    this.db.prepare("DELETE FROM recommendation_candidates").run();
  }

  resetRecommendationRefreshDates(): void {
    this.db.prepare("DELETE FROM app_state WHERE key LIKE 'recommendation_refresh:%'").run();
  }

  getRecommendationDataVersion(): number {
    return this.getAppState<number>("recommendation_data_version") ?? 0;
  }

  saveRecommendationDataVersion(version: number): void {
    this.saveAppState("recommendation_data_version", version);
  }

  saveRecommendationRefreshDate(source: RecommendationSource, date: string): void {
    this.saveAppState(`recommendation_refresh:${source}`, date);
  }

  getRecommendationRefreshDate(source: RecommendationSource): string | undefined {
    return this.getAppState<string>(`recommendation_refresh:${source}`);
  }

  getIntelligencePolicyState(): IntelligencePolicyState | undefined {
    return this.getAppState<IntelligencePolicyState>("intelligence_policy");
  }

  saveIntelligencePolicyState(state: IntelligencePolicyState): void {
    this.saveAppState("intelligence_policy", state);
  }

  loadListeningPolicyState(): ListeningPolicyState {
    const observations = this.db
      .prepare("SELECT observation_json FROM listening_observations ORDER BY observed_at")
      .all()
      .map((row) => parseJson<ListeningObservation>((row as { observation_json: string }).observation_json, {} as ListeningObservation));
    const signals = this.db
      .prepare("SELECT signal_json FROM preference_signals ORDER BY updated_at")
      .all()
      .map((row) => parseJson<PreferenceSignal>((row as { signal_json: string }).signal_json, {} as PreferenceSignal));
    const receipts = this.db
      .prepare("SELECT receipt_json FROM learning_receipts ORDER BY created_at")
      .all()
      .map((row) => parseJson<PolicyLearningReceipt>((row as { receipt_json: string }).receipt_json, {} as PolicyLearningReceipt));
    return { observations, signals, receipts };
  }

  appendListeningObservation(observation: ListeningObservation): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO listening_observations(observation_id, observation_json, observed_at) VALUES (?, ?, ?)"
      )
      .run(observation.observationId, JSON.stringify(observation), observation.at);
  }

  replacePreferenceSignals(signals: PreferenceSignal[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM preference_signals").run();
      const insert = this.db.prepare(
        "INSERT INTO preference_signals(signal_id, signal_json, updated_at) VALUES (?, ?, ?)"
      );
      for (const signal of signals) insert.run(signal.signalId, JSON.stringify(signal), signal.updatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitLearningMutation(
    observation: ListeningObservation,
    signals: PreferenceSignal[],
    receipt: PolicyLearningReceipt
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO listening_observations(observation_id, observation_json, observed_at) VALUES (?, ?, ?)"
      ).run(observation.observationId, JSON.stringify(observation), observation.at);
      this.db.prepare("DELETE FROM preference_signals").run();
      const insertSignal = this.db.prepare(
        "INSERT INTO preference_signals(signal_id, signal_json, updated_at) VALUES (?, ?, ?)"
      );
      for (const signal of signals) {
        insertSignal.run(signal.signalId, JSON.stringify(signal), signal.updatedAt);
      }
      this.db.prepare(
        `INSERT INTO learning_receipts(
          receipt_id, undo_token, receipt_json, created_at, undo_expires_at, undone_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id) DO UPDATE SET
          receipt_json=excluded.receipt_json,
          undone_at=excluded.undone_at`
      ).run(
        receipt.receiptId,
        receipt.undoToken,
        JSON.stringify(receipt),
        new Date().toISOString(),
        receipt.undoExpiresAt,
        receipt.undoneAt ?? null
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveRecommendationDecisions(decisions: RankedDecision[]): void {
    const insert = this.db.prepare(
      `INSERT INTO recommendation_decisions(decision_id, decision_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(decision_id) DO UPDATE SET decision_json=excluded.decision_json`
    );
    const createdAt = new Date().toISOString();
    for (const decision of decisions) insert.run(decision.decisionId, JSON.stringify(decision), createdAt);
  }

  getRecommendationDecision(decisionId: string): RankedDecision | undefined {
    const row = this.db
      .prepare("SELECT decision_json FROM recommendation_decisions WHERE decision_id = ?")
      .get(decisionId) as { decision_json: string } | undefined;
    return row ? parseJson<RankedDecision | undefined>(row.decision_json, undefined) : undefined;
  }

  saveLearningReceipt(receipt: PolicyLearningReceipt): void {
    this.db
      .prepare(
        `INSERT INTO learning_receipts(
          receipt_id, undo_token, receipt_json, created_at, undo_expires_at, undone_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id) DO UPDATE SET
          receipt_json=excluded.receipt_json,
          undone_at=excluded.undone_at`
      )
      .run(
        receipt.receiptId,
        receipt.undoToken,
        JSON.stringify(receipt),
        new Date().toISOString(),
        receipt.undoExpiresAt,
        receipt.undoneAt ?? null
      );
  }

  getLearningReceipt(undoToken: string): PolicyLearningReceipt | undefined {
    const row = this.db
      .prepare("SELECT receipt_json FROM learning_receipts WHERE undo_token = ?")
      .get(undoToken) as { receipt_json: string } | undefined;
    return row ? parseJson<PolicyLearningReceipt | undefined>(row.receipt_json, undefined) : undefined;
  }

  markLearningReceiptUndone(undoToken: string, undoneAt: string): void {
    this.db.prepare("UPDATE learning_receipts SET undone_at = ? WHERE undo_token = ?").run(undoneAt, undoToken);
  }

  recordPlaybackOutcome(request: PlaybackOutcomeRequest): boolean {
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO playback_outcomes(playback_id, outcome_json, observed_at) VALUES (?, ?, ?)"
      )
      .run(request.playbackId, JSON.stringify(request), request.at ?? new Date().toISOString());
    return inserted.changes > 0;
  }

  releasePlaybackOutcome(playbackId: string): void {
    this.db.prepare("DELETE FROM playback_outcomes WHERE playback_id = ?").run(playbackId);
  }

  upsertSessionIntent(intent: SessionIntent): void {
    this.db
      .prepare(
        `INSERT INTO session_intents(intent_id, intent_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(intent_id) DO UPDATE SET
           intent_json=excluded.intent_json,
           expires_at=excluded.expires_at,
           updated_at=excluded.updated_at`
      )
      .run(intent.intentId, JSON.stringify(intent), intent.expiresAt, intent.updatedAt);
  }

  getActiveSessionIntents(at: string): SessionIntent[] {
    return this.db
      .prepare("SELECT intent_json FROM session_intents WHERE expires_at > ? ORDER BY updated_at DESC")
      .all(at)
      .map((row) => parseJson<SessionIntent>((row as { intent_json: string }).intent_json, {} as SessionIntent));
  }

  expireSessionIntents(at: string): number {
    return Number(this.db.prepare("DELETE FROM session_intents WHERE expires_at <= ?").run(at).changes);
  }

  clearSessionIntents(): void {
    this.db.prepare("DELETE FROM session_intents").run();
  }

  getListeningSessionState(): { sessionId: string; lastInteractionAt: string } | undefined {
    const state = this.getAppState<{ sessionId?: unknown; lastInteractionAt?: unknown }>("listening_session");
    if (
      !state ||
      typeof state.sessionId !== "string" ||
      !state.sessionId ||
      typeof state.lastInteractionAt !== "string" ||
      !Number.isFinite(Date.parse(state.lastInteractionAt))
    ) return undefined;
    return { sessionId: state.sessionId, lastInteractionAt: state.lastInteractionAt };
  }

  saveListeningSessionState(state: { sessionId: string; lastInteractionAt: string }): void {
    this.saveAppState("listening_session", state);
  }

  pruneIntelligenceHistory(before: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM recommendation_decisions WHERE created_at < ?").run(before);
      this.db.prepare("DELETE FROM listening_observations WHERE observed_at < ?").run(before);
      this.db.prepare("DELETE FROM playback_outcomes WHERE observed_at < ?").run(before);
      this.db.prepare("DELETE FROM play_events WHERE at < ?").run(before);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addPlayEvent(event: PlayEvent): void {
    const trackKey = normalizeTrackReference(event.trackId);
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO play_events(
          track_key, event_type, at, metadata_json, event_id, recording_key, source,
          reason, scope, playback_id, decision_id, listened_ms, duration_ms,
          turn_id, session_id, context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trackKey,
        event.type,
        event.at,
        JSON.stringify(event.metadata ?? {}),
        event.eventId ?? null,
        event.recordingKey ?? null,
        event.source ?? null,
        event.reason ?? null,
        event.scope ?? null,
        event.playbackId ?? null,
        event.decisionId ?? null,
        event.listenedMs ?? null,
        event.durationMs ?? null,
        event.turnId ?? null,
        event.sessionId ?? null,
        event.context ? JSON.stringify(event.context) : null
      );
    if (inserted.changes === 0) return;

    if (
      event.type === "play" ||
      event.type === "play_start" ||
      event.type === "replay" ||
      event.type === "complete"
    ) {
      const hour = new Date(event.at).getHours();
      this.db
        .prepare(
          "UPDATE track_stats SET last_played_at = ?, last_played_hour = ?, play_count = play_count + ? WHERE track_key = ?"
        )
        .run(event.at, hour, event.type === "complete" ? 1 : 0, trackKey);
    }
  }

  private ensureIntelligenceSchema(): void {
    const columns = this.tableColumns("play_events");
    const additions: Array<[string, string]> = [
      ["event_id", "TEXT"],
      ["recording_key", "TEXT"],
      ["source", "TEXT"],
      ["reason", "TEXT"],
      ["scope", "TEXT"],
      ["playback_id", "TEXT"],
      ["decision_id", "TEXT"],
      ["listened_ms", "INTEGER"],
      ["duration_ms", "INTEGER"],
      ["turn_id", "TEXT"],
      ["session_id", "TEXT"],
      ["context_json", "TEXT"]
    ];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [name, sqlType] of additions) {
        if (!columns.includes(name)) this.db.exec(`ALTER TABLE play_events ADD COLUMN ${name} ${sqlType}`);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_play_events_event_id
          ON play_events(event_id) WHERE event_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_play_events_playback_id ON play_events(playback_id);
        CREATE INDEX IF NOT EXISTS idx_play_events_decision_id ON play_events(decision_id);
        CREATE TABLE IF NOT EXISTS listening_observations (
          observation_id TEXT PRIMARY KEY,
          observation_json TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS preference_signals (
          signal_id TEXT PRIMARY KEY,
          signal_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recommendation_decisions (
          decision_id TEXT PRIMARY KEY,
          decision_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_intents (
          intent_id TEXT PRIMARY KEY,
          intent_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS learning_receipts (
          receipt_id TEXT PRIMARY KEY,
          undo_token TEXT NOT NULL UNIQUE,
          receipt_json TEXT NOT NULL,
          inverse_observation_json TEXT,
          created_at TEXT NOT NULL,
          undo_expires_at TEXT NOT NULL,
          undone_at TEXT
        );
        CREATE TABLE IF NOT EXISTS playback_outcomes (
          playback_id TEXT PRIMARY KEY,
          outcome_json TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRecentPlayEvents(limit = 120): PlayEvent[] {
    const rows = this.db
      .prepare(
        `SELECT track_key, event_type, at, metadata_json, event_id, recording_key, source,
          reason, scope, playback_id, decision_id, listened_ms, duration_ms,
          turn_id, session_id, context_json
         FROM play_events ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as unknown as PlayEventRow[];

    return rows.map(toPlayEvent);
  }

  getPlayEventsSince(since: string): PlayEvent[] {
    const rows = this.db
      .prepare(
        `SELECT track_key, event_type, at, metadata_json, event_id, recording_key, source,
          reason, scope, playback_id, decision_id, listened_ms, duration_ms,
          turn_id, session_id, context_json
         FROM play_events WHERE at >= ? ORDER BY id DESC`
      )
      .all(since) as unknown as PlayEventRow[];

    return rows.map(toPlayEvent);
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

  saveDailyPlan(plan: DailyPlan): void {
    this.saveAppState("daily_plan", plan);
  }

  getDailyPlan(): DailyPlan | undefined {
    return this.getAppState<DailyPlan>("daily_plan");
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

  addChatMessage(message: ChatMessage & { metadata?: Record<string, unknown> }): ChatMessage {
    if (message.turnId) {
      const existing = this.db
        .prepare(`
          SELECT id, role, text, at, metadata_json, turn_id, source, status, model, session_id
          FROM chat_messages WHERE turn_id = ? AND role = ?
        `)
        .get(message.turnId, message.role) as ChatMessageRow | undefined;
      if (existing) {
        return this.mapChatMessage(existing);
      }
    }
    const result = this.db
      .prepare(`
        INSERT INTO chat_messages(
          role, text, at, metadata_json, turn_id, source, status, model, session_id
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.role,
        message.text,
        message.at,
        JSON.stringify({
          ...message.metadata,
          trackSuggestion: message.trackSuggestion
        }),
        message.turnId ?? null,
        message.source ?? "text",
        message.status ?? "completed",
        message.model ?? null,
        message.sessionId ?? null
      );
    this.bumpConversationRevision();
    return { ...message, id: Number(result.lastInsertRowid) };
  }

  updateChatMessageForTurn(
    turnId: string,
    role: ChatMessage["role"],
    patch: Pick<ChatMessage, "text" | "at"> & Partial<Pick<ChatMessage, "status" | "model">>
  ): ChatMessage | undefined {
    const result = this.db.prepare(`
      UPDATE chat_messages
      SET text = ?, at = ?, status = COALESCE(?, status), model = COALESCE(?, model)
      WHERE turn_id = ? AND role = ?
    `).run(patch.text, patch.at, patch.status ?? null, patch.model ?? null, turnId, role);
    if (Number(result.changes) > 0) this.bumpConversationRevision();
    return this.getChatMessageForTurn(turnId, role);
  }

  getChatMessageForTurn(turnId: string, role: ChatMessage["role"]): ChatMessage | undefined {
    const row = this.db.prepare(`
      SELECT id, role, text, at, metadata_json, turn_id, source, status, model, session_id
      FROM chat_messages WHERE turn_id = ? AND role = ?
    `).get(turnId, role) as ChatMessageRow | undefined;
    return row ? this.mapChatMessage(row) : undefined;
  }

  getRecentMessages(limit = 30): ChatMessage[] {
    const rows = this.db
      .prepare(`
        SELECT id, role, text, at, metadata_json, turn_id, source, status, model, session_id
        FROM chat_messages ORDER BY id DESC LIMIT ?
      `)
      .all(limit) as unknown as ChatMessageRow[];
    return rows
      .slice()
      .reverse()
      .map((row) => this.mapChatMessage(row));
  }

  getChatMessage(id: number): ChatMessage | undefined {
    const row = this.db
      .prepare(`
        SELECT id, role, text, at, metadata_json, turn_id, source, status, model, session_id
        FROM chat_messages WHERE id = ?
      `)
      .get(id) as ChatMessageRow | undefined;
    return row ? this.mapChatMessage(row) : undefined;
  }

  clearChatMessages(): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM chat_messages").run();
      this.db.prepare("DELETE FROM conversation_tool_calls").run();
      this.bumpConversationRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getConversationRevision(): number {
    return this.getAppState<number>("conversation_revision") ?? 0;
  }

  saveConversationToolCall(input: {
    commandId: string;
    turnId: string;
    toolName: string;
    request: unknown;
    result: unknown;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO conversation_tool_calls(
        command_id, turn_id, tool_name, request_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.commandId,
      input.turnId,
      input.toolName,
      JSON.stringify(input.request),
      JSON.stringify(input.result),
      input.createdAt
    );
  }

  getConversationToolCall(commandId: string): {
    commandId: string;
    turnId: string;
    toolName: string;
    request: unknown;
    result: unknown;
    createdAt: string;
    consumedAt?: string;
  } | undefined {
    const row = this.db.prepare(`
      SELECT command_id, turn_id, tool_name, request_json, result_json, created_at, consumed_at
      FROM conversation_tool_calls WHERE command_id = ?
    `).get(commandId) as {
      command_id: string;
      turn_id: string;
      tool_name: string;
      request_json: string;
      result_json: string;
      created_at: string;
      consumed_at: string | null;
    } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      commandId: row.command_id,
      turnId: row.turn_id,
      toolName: row.tool_name,
      request: parseJson(row.request_json, undefined),
      result: parseJson(row.result_json, undefined),
      createdAt: row.created_at,
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {})
    };
  }

  consumeConversationToolCall(commandId: string, at = new Date().toISOString()): boolean {
    const result = this.db.prepare(`
      UPDATE conversation_tool_calls SET consumed_at = ?
      WHERE command_id = ? AND consumed_at IS NULL
    `).run(at, commandId);
    return Number(result.changes) > 0;
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

  private mapChatMessage(row: ChatMessageRow): ChatMessage {
    const metadata = parseJson<{
      trackSuggestion?: ChatMessage["trackSuggestion"];
    }>(row.metadata_json ?? null, {});
    const message: ChatMessage = {
      id: row.id,
      role: row.role,
      text: row.text,
      at: row.at,
      source: row.source === "voice" ? "voice" : "text",
      status: row.status === "interrupted" || row.status === "failed" ? row.status : "completed"
    };
    if (row.turn_id) message.turnId = row.turn_id;
    if (row.model) message.model = row.model;
    if (row.session_id) message.sessionId = row.session_id;
    if (metadata.trackSuggestion) {
      message.trackSuggestion = metadata.trackSuggestion;
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

  private bumpConversationRevision(): number {
    const revision = this.getConversationRevision() + 1;
    this.saveAppState("conversation_revision", revision);
    return revision;
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

interface ChatMessageRow {
  id: number;
  role: ChatMessage["role"];
  text: string;
  at: string;
  metadata_json?: string | null;
  turn_id: string | null;
  source: string;
  status: string;
  model: string | null;
  session_id: string | null;
}

interface ChatMemoryRow {
  id: number;
  category: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface PlayEventRow {
  track_key: string;
  event_type: PlayEvent["type"];
  at: string;
  metadata_json: string | null;
  event_id: string | null;
  recording_key: string | null;
  source: string | null;
  reason: string | null;
  scope: string | null;
  playback_id: string | null;
  decision_id: string | null;
  listened_ms: number | null;
  duration_ms: number | null;
  turn_id: string | null;
  session_id: string | null;
  context_json: string | null;
}

function toPlayEvent(row: PlayEventRow): PlayEvent {
  return {
    trackId: row.track_key,
    type: row.event_type,
    at: row.at,
    metadata: parseJson(row.metadata_json, {}),
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.recording_key ? { recordingKey: row.recording_key } : {}),
    ...(row.source === "ncm" || row.source === "qq" ? { source: row.source } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.scope === "session" || row.scope === "day" || row.scope === "long_term"
      ? { scope: row.scope }
      : {}),
    ...(row.playback_id ? { playbackId: row.playback_id } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.listened_ms !== null ? { listenedMs: row.listened_ms } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.context_json
      ? { context: parseJson<Record<string, string | number | boolean>>(row.context_json, {}) }
      : {})
  };
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
