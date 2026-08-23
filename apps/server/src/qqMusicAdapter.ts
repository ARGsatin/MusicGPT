import fs from "node:fs";
import path from "node:path";

import type {
  LibraryEvidence,
  MusicSourceStatus,
  QqAuthQrResponse,
  QqAuthStatusResponse,
  Track,
  TrackLyrics
} from "@musicgpt/shared";

import type { MusicSourceAdapter, MusicSourceSyncResult } from "./musicCatalog.js";
import { normalizeTrackIdentity } from "./musicCatalog.js";
import { resolveQqPlayback } from "./qqPlayback.js";

export interface QqQrSecret {
  imageDataUrl: string;
  token: string | number;
  signature: string;
}

export interface QqLoginCheck {
  status: "pending" | "authorized" | "expired" | "error";
  message?: string;
  cookie?: string;
  accountId?: string;
  accountLabel?: string;
}

export interface QqPlaylistSummary {
  id: string;
  name: string;
  liked?: boolean;
}

export interface QqPlaylistPage {
  total: number;
  items: QqPlaylistSummary[];
}

export interface QqTrackRecord {
  sourceId: string;
  playbackId?: string;
  lyricsId?: string;
  requiresSubscription?: boolean;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  coverUrl?: string;
}

export interface QqMusicClient {
  createQr(): Promise<QqQrSecret>;
  checkQr(secret: Pick<QqQrSecret, "token" | "signature">): Promise<QqLoginCheck>;
  listPlaylists(input: { accountId: string; cookie: string; offset: number; limit: number }): Promise<QqPlaylistPage>;
  getPlaylistTracks(playlistId: string, cookie: string): Promise<QqTrackRecord[]>;
  search(query: string, cookie?: string): Promise<QqTrackRecord[]>;
  resolvePlayback(
    sourceId: string,
    cookie?: string,
    metadata?: Pick<Track, "playbackId" | "requiresSubscription">
  ): Promise<string | undefined>;
  getLyrics(sourceId: string, cookie?: string, lyricsId?: string): Promise<Omit<TrackLyrics, "trackId">>;
}

interface QqSessionFile {
  accountId: string;
  accountLabel?: string;
  cookie: string;
  authorizedAt: string;
  lastSyncAt?: string;
  lastError?: string;
}

interface QqAdapterOptions {
  pageSize?: number;
}

export class QqMusicAdapter implements MusicSourceAdapter {
  readonly source = "qq" as const;
  private readonly configDir: string;
  private readonly sessionPath: string;
  private readonly qrSessions = new Map<string, QqQrSecret & { expiresAt: string }>();
  private readonly pageSize: number;

  constructor(
    stateDir: string,
    private readonly client: QqMusicClient = createDefaultQqMusicClient(path.join(stateDir, "qqmusic")),
    options: QqAdapterOptions = {}
  ) {
    this.configDir = path.join(stateDir, "qqmusic");
    this.sessionPath = path.join(this.configDir, "session.json");
    this.pageSize = options.pageSize ?? 30;
    fs.mkdirSync(this.configDir, { recursive: true });
  }

  async createQr(): Promise<QqAuthQrResponse> {
    const secret = await this.client.createQr();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3 * 60_000).toISOString();
    this.qrSessions.set(sessionId, { ...secret, expiresAt });
    return { sessionId, imageDataUrl: secret.imageDataUrl, expiresAt };
  }

  async pollQr(sessionId: string): Promise<QqAuthStatusResponse> {
    const secret = this.qrSessions.get(sessionId);
    if (!secret || Date.parse(secret.expiresAt) <= Date.now()) {
      this.qrSessions.delete(sessionId);
      return { sessionId, status: "expired", message: "二维码已过期" };
    }
    const result = await this.client.checkQr({ token: secret.token, signature: secret.signature });
    if (result.status === "authorized" && result.cookie && result.accountId) {
      this.writeSession({
        accountId: result.accountId,
        ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}),
        cookie: result.cookie,
        authorizedAt: new Date().toISOString()
      });
      this.qrSessions.delete(sessionId);
    }
    if (result.status === "expired" || result.status === "error") {
      this.qrSessions.delete(sessionId);
    }
    return {
      sessionId,
      status: result.status,
      ...(result.message ? { message: result.message } : {})
    };
  }

  disconnect(): void {
    this.qrSessions.clear();
    for (const name of ["session.json", "user-info.json", "user.json", "cookie.json"]) {
      const target = path.join(this.configDir, name);
      if (fs.existsSync(target)) fs.rmSync(target);
    }
  }

  async status(): Promise<MusicSourceStatus> {
    const session = this.readSession();
    return {
      source: "qq",
      enabled: true,
      connected: Boolean(session?.cookie),
      ...(session?.accountLabel ? { accountLabel: session.accountLabel } : {}),
      ...(session?.lastSyncAt ? { lastSyncAt: session.lastSyncAt } : {}),
      ...(session?.lastError ? { lastError: session.lastError } : {}),
      capabilities: {
        accountLibrary: true,
        recentPlays: false,
        search: true,
        recommendations: false,
        playback: true,
        lyrics: true
      }
    };
  }

  async sync(): Promise<MusicSourceSyncResult> {
    const session = this.requireSession();
    try {
      const playlists: QqPlaylistSummary[] = [];
      for (let offset = 0, page = 0; page < 100; page += 1, offset += this.pageSize) {
        const result = await this.client.listPlaylists({
          accountId: session.accountId,
          cookie: session.cookie,
          offset,
          limit: this.pageSize
        });
        playlists.push(...result.items);
        if (playlists.length >= result.total || result.items.length === 0) break;
      }

      const tracksByKey = new Map<string, Track>();
      const evidence: LibraryEvidence[] = [];
      const observedAt = new Date().toISOString();
      for (const playlist of dedupePlaylists(playlists)) {
        const records = await this.client.getPlaylistTracks(playlist.id, session.cookie);
        for (const record of records) {
          const track = normalizeQqTrack(record);
          tracksByKey.set(track.trackKey!, track);
          evidence.push({
            recordingKey: track.recordingKey!,
            trackKey: track.trackKey!,
            source: "qq",
            kind: playlist.liked || /我喜欢|liked/i.test(playlist.name) ? "platform_like" : "playlist",
            observedAt,
            containerId: playlist.id,
            containerName: playlist.name
          });
        }
      }
      const { lastError: _lastError, ...healthySession } = session;
      this.writeSession({ ...healthySession, lastSyncAt: observedAt });
      return {
        source: "qq",
        tracks: [...tracksByKey.values()],
        evidence,
        warnings: ["qq_recent_plays_unavailable"]
      };
    } catch (error) {
      const message = safeError(error);
      this.writeSession({ ...session, lastError: message });
      throw new Error(message === "qq_cookie_expired" ? message : `qq_sync_failed:${message}`);
    }
  }

  async search(query: string): Promise<Track[]> {
    const cookie = this.readSession()?.cookie;
    if (!cookie) return [];
    return (await this.client.search(query, cookie)).map(normalizeQqTrack);
  }

  async recommend(): Promise<Track[]> {
    return [];
  }

  async resolvePlayback(track: Track): Promise<string | undefined> {
    return this.client.resolvePlayback(
      track.sourceId ?? String(track.id),
      this.readSession()?.cookie,
      {
        ...(track.playbackId ? { playbackId: track.playbackId } : {}),
        ...(track.requiresSubscription !== undefined
          ? { requiresSubscription: track.requiresSubscription }
          : {})
      }
    );
  }

  async getLyrics(track: Track): Promise<TrackLyrics> {
    const result = await this.client.getLyrics(
      track.sourceId ?? String(track.id),
      this.readSession()?.cookie,
      track.lyricsId
    );
    return { trackId: track.trackKey ?? `qq:${track.sourceId ?? track.id}`, ...result };
  }

  private requireSession(): QqSessionFile {
    const session = this.readSession();
    if (!session?.cookie) throw new Error("qq_not_connected");
    return session;
  }

  private readSession(): QqSessionFile | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.sessionPath, "utf8")) as QqSessionFile;
    } catch {
      return undefined;
    }
  }

  private writeSession(session: QqSessionFile): void {
    const value = Object.fromEntries(Object.entries(session).filter(([, item]) => item !== undefined));
    atomicWrite(this.sessionPath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function normalizeQqTrack(record: QqTrackRecord): Track {
  return normalizeTrackIdentity(
    {
      id: record.sourceId,
      source: "qq",
      sourceId: record.sourceId,
      ...(record.playbackId ? { playbackId: record.playbackId } : {}),
      ...(record.lyricsId ? { lyricsId: record.lyricsId } : {}),
      ...(record.requiresSubscription !== undefined
        ? { requiresSubscription: record.requiresSubscription }
        : {}),
      title: record.title,
      artists: record.artists,
      ...(record.album ? { album: record.album } : {}),
      ...(record.durationMs ? { durationMs: record.durationMs } : {}),
      ...(record.coverUrl ? { coverUrl: record.coverUrl } : {})
    },
    "qq"
  );
}

function dedupePlaylists(items: QqPlaylistSummary[]): QqPlaylistSummary[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function atomicWrite(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents, "utf8");
  replaceFile(temp, filePath);
}

function replaceFile(temp: string, target: string): void {
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (!isReplaceError(error)) throw error;
    fs.copyFileSync(temp, target);
    fs.rmSync(temp);
  }
}

function isReplaceError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "EPERM" || error.code === "EEXIST" || error.code === "EACCES");
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(/(["']?(?:cookie|uin|qqmusic_key|qm_keyst)["']?\s*[=:]\s*)["']?[^\s,;}"']+["']?/giu, "$1[REDACTED]")
    .slice(0, 500);
  return /qq_cookie_expired|(?:cookie|登录|login).*(?:expired|失效|过期|未登录)|unauthori[sz]ed|\b401\b|\b403\b/iu.test(redacted)
    ? "qq_cookie_expired"
    : redacted;
}

function createDefaultQqMusicClient(configDir: string): QqMusicClient {
  process.env.QQ_MUSIC_API_CONFIG_DIR = configDir;
  const sdk = () => import("@sansenjian/qq-music-api/sdk");
  const services = () => import("@sansenjian/qq-music-api/services");
  return {
    createQr: async () => {
      const response = await callQqSdkSafely(async () => (await sdk()).getLoginQr());
      const body = requireQqResponse(response, "qq_qr_create_failed");
      const image = pickOptionalString(body, ["img", "image", "qrcode"]);
      const token = pickValue(body, ["ptqrtoken", "token"]);
      const signature = pickOptionalString(body, ["qrsig", "signature"]);
      if (!image || token === undefined || !signature) throw new Error("qq_qr_response_invalid");
      return {
        imageDataUrl: normalizeQrImage(image),
        token: token as string | number,
        signature
      };
    },
    checkQr: async ({ token, signature }) => {
      let body: Record<string, unknown>;
      try {
        const response = await callQqSdkSafely(async () =>
          (await sdk()).checkLoginQr({ ptqrtoken: token, qrsig: signature })
        );
        body = requireQqResponse(response, "qq_qr_check_failed");
      } catch {
        return { status: "error", message: "QQ 登录检查失败" };
      }
      if (body.isOk === true && isObject(body.session)) {
        return {
          status: "authorized",
          cookie: pickString(body.session, ["cookie"]),
          accountId: pickString(body.session, ["uin", "loginUin"]),
          accountLabel: `QQ ${pickString(body.session, ["uin", "loginUin"])}`
        };
      }
      const message = pickOptionalString(body, ["message", "msg"]);
      return {
        status: body.refresh === true ? "expired" : "pending",
        ...(message ? { message } : {})
      };
    },
    listPlaylists: async ({ accountId, cookie, offset, limit }) => {
      const response = await callQqSdkSafely(async () =>
        (await services()).getUserPlaylists({
          uin: accountId,
          cookie,
          offset,
          limit
        })
      );
      const body = requireQqResponse(response, "qq_playlists_failed");
      const raw = findArray(body, ["playlists", "list"]);
      return {
        total: pickOptionalNumber(body, ["total", "totalCount"]) ?? Math.max(offset + raw.length, raw.length),
        items: raw.flatMap((item) => {
          if (!isObject(item)) return [];
          const id = pickOptionalString(item, ["dissid", "tid", "id"]);
          if (!id) return [];
          const name = pickOptionalString(item, ["dissname", "title", "name"]) ?? `QQ 歌单 ${id}`;
          return [{ id, name, liked: /我喜欢|liked/i.test(name) }];
        })
      };
    },
    getPlaylistTracks: async (playlistId, cookie) => {
      const response = await callQqSdkSafely(async () =>
        (await services()).songListDetail({
          method: "get",
          params: { disstid: playlistId },
          option: { headers: { Cookie: cookie } }
        })
      );
      return extractQqPlaylistTracks(response);
    },
    search: async (query) => {
      const response = await callQqSdkSafely(async () =>
        (await sdk()).search({ key: query, limit: 20, page: 1 })
      );
      return findArray(requireQqResponse(response, "qq_search_failed"), ["list", "songlist", "songs"])
        .flatMap(normalizeUnknownQqTrack);
    },
    resolvePlayback: async (sourceId, cookie, metadata) => {
      return resolveQqPlayback({
        sourceId,
        ...(metadata?.playbackId ? { mediaId: metadata.playbackId } : {}),
        ...(cookie ? { cookie } : {})
      });
    },
    getLyrics: async (sourceId, cookie, lyricsId) => {
      const response = await callQqSdkSafely(async () =>
        (await sdk()).lyric({
          songmid: sourceId,
          ...(lyricsId ? { songid: lyricsId } : {}),
          isFormat: false,
          ...(cookie ? { cookie } : {})
        })
      );
      const body = requireQqResponse(response, "qq_lyrics_unavailable");
      const raw = pickOptionalString(body, ["lyric", "lrc"]);
      return raw ? { pureMusic: false, lines: parseLrc(raw) } : { pureMusic: true, lines: [] };
    }
  };
}

export function extractQqPlaylistTracks(value: unknown): QqTrackRecord[] {
  return (findNamedArray(requireQqResponse(value, "qq_playlist_tracks_failed"), ["songlist", "songList", "songs", "list"]) ?? [])
    .flatMap(normalizeUnknownQqTrack);
}

let qqSdkCallQueue: Promise<void> = Promise.resolve();

/**
 * The fixed QQ SDK prints the full thrown request object in a few service error
 * paths. Serialize SDK calls and redact console errors while one is in flight so
 * an Axios config cannot expose a Cookie header in local logs.
 */
async function callQqSdkSafely<T>(operation: () => Promise<T>): Promise<T> {
  const run = qqSdkCallQueue.then(async () => {
    const originalError = console.error;
    const redactingError = (...args: unknown[]) => originalError(...args.map(redactQqLogValue));
    console.error = redactingError;
    try {
      return await operation();
    } finally {
      if (console.error === redactingError) console.error = originalError;
    }
  });
  qqSdkCallQueue = run.then(() => undefined, () => undefined);
  return run;
}

function redactQqLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactQqSecrets(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactQqSecrets(value.message) };
  }
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value, (key, nested) =>
      /^(?:cookie|set-cookie|uin|qqmusic_key|qm_keyst)$/iu.test(key)
        ? "[REDACTED]"
        : typeof nested === "string" ? redactQqSecrets(nested) : nested
    )) as unknown;
  } catch {
    return "[QQ SDK error object redacted]";
  }
}

function redactQqSecrets(value: string): string {
  return value.replace(
    /((?:cookie|set-cookie|uin|qqmusic_key|qm_keyst)\s*[=:]\s*)[^\s,;}&]+/giu,
    "$1[REDACTED]"
  );
}

function requireQqResponse(value: unknown, fallback: string): Record<string, unknown> {
  const status = isObject(value) && typeof value.status === "number" ? value.status : 200;
  const body = isObject(value) && isObject(value.body) ? value.body : isObject(value) ? value : {};
  if (status >= 400 || body.error !== undefined) {
    const detail = readErrorText(body.error) ?? readErrorText(body.message) ?? fallback;
    throw new Error(detail);
  }
  return unwrapResponse(value);
}

function readErrorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Error) return value.message;
  if (isObject(value)) {
    for (const key of ["message", "msg", "error"]) {
      const nested = readErrorText(value[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function unwrapResponse(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  const body = isObject(value.body) ? value.body : value;
  const response = isObject(body.response) ? body.response : body;
  const data = isObject(response.data) ? response.data : response;
  return data;
}

function normalizeUnknownQqTrack(value: unknown): QqTrackRecord[] {
  if (!isObject(value)) return [];
  const sourceId = pickOptionalString(value, ["songmid", "song_mid", "mid"]);
  const title = pickOptionalString(value, ["songname", "name", "title"]);
  if (!sourceId || !title) return [];
  const singer = Array.isArray(value.singer) ? value.singer : Array.isArray(value.artists) ? value.artists : [];
  const artists = singer.flatMap((item) =>
    typeof item === "string" ? [item] : isObject(item) ? [pickOptionalString(item, ["name", "title"]) ?? ""] : []
  ).filter(Boolean);
  const seconds = pickOptionalNumber(value, ["interval", "duration"]);
  const file = isObject(value.file) ? value.file : {};
  const pay = isObject(value.pay) ? value.pay : {};
  const playbackId = pickOptionalString(file, ["media_mid", "mediaMid", "strMediaMid"])
    ?? pickOptionalString(value, ["media_mid", "mediaMid", "strMediaMid"]);
  const lyricsId = pickOptionalString(value, ["songid", "song_id"]);
  const payPlay = pickOptionalNumber(pay, ["payplay", "pay_play"])
    ?? pickOptionalNumber(value, ["payplay", "pay_play"]);
  return [{
    sourceId,
    ...(playbackId ? { playbackId } : {}),
    ...(lyricsId ? { lyricsId } : {}),
    ...(payPlay !== undefined ? { requiresSubscription: payPlay > 0 } : {}),
    title,
    artists: artists.length > 0 ? artists : ["未知艺术家"],
    ...(pickOptionalString(value, ["albumname", "album_name"]) ? { album: pickString(value, ["albumname", "album_name"]) } : {}),
    ...(seconds ? { durationMs: seconds > 10_000 ? seconds : seconds * 1000 } : {})
  }];
}

function findArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  for (const nested of Object.values(value)) {
    const found = findArray(nested, keys);
    if (found.length > 0) return found;
  }
  return [];
}

function findNamedArray(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNamedArray(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as unknown[];
  for (const nested of Object.values(value)) {
    const found = findNamedArray(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function parseLrc(raw: string): Array<{ timeMs: number; text: string }> {
  return raw.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/u);
    if (!match) return [];
    return [{ timeMs: Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000), text: match[3]!.trim() }];
  }).filter((line) => line.text.length > 0);
}

function normalizeQrImage(value: string): string {
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}

function pickValue(value: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (value[key] !== undefined) return value[key];
  return undefined;
}

function pickString(value: Record<string, unknown>, keys: string[]): string {
  return pickOptionalString(value, keys) ?? "";
}

function pickOptionalString(value: Record<string, unknown>, keys: string[]): string | undefined {
  const found = pickValue(value, keys);
  return typeof found === "string" || typeof found === "number" ? String(found) : undefined;
}

function pickOptionalNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  const found = Number(pickValue(value, keys));
  return Number.isFinite(found) ? found : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
