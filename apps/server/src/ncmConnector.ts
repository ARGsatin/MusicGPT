import { inferMood } from "./moodClassifier.js";

import type {
  LyricLine,
  NcmImportErrorCode,
  Track,
  TrackLyrics,
  TrackStat
} from "@musicgpt/shared";

interface NcmAccountPayload {
  account?: {
    id?: number;
    anonimousUser?: boolean;
    anonymousUser?: boolean;
    status?: number;
  };
  profile?: {
    userId?: number;
  };
}

interface NcmAccountResponse extends NcmAccountPayload {
  data?: NcmAccountPayload;
}

interface NcmLikeListResponse {
  ids?: Array<number | { id: number; t?: number }>;
  checkPoint?: number;
}

interface NcmSongDetailResponse {
  songs?: Array<{
    id: number;
    name: string;
    ar?: Array<{ name: string }>;
    al?: { name?: string; picUrl?: string };
    dt?: number;
  }>;
}

interface NcmUserRecordResponse {
  allData?: Array<{
    playCount: number;
    score?: number;
    song?: {
      id: number;
      name: string;
      ar?: Array<{ name: string }>;
      al?: { name?: string; picUrl?: string };
      dt?: number;
    };
  }>;
}
type UserRecordItem = NonNullable<NcmUserRecordResponse["allData"]>[number];

interface NcmSongUrlResponse {
  data?: Array<{ id: number; url?: string }>;
}

interface NcmSearchResponse {
  result?: {
    songs?: Array<{
      id: number;
      name: string;
      artists?: Array<{ name: string }>;
      album?: { name?: string; picUrl?: string };
      duration?: number;
    }>;
  };
}

interface NcmLyricResponse {
  nolyric?: boolean;
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
}

const METADATA_LINE_PATTERN =
  /^(作词|作曲|编曲|制作人|监制|出品|发行|混音|录音|母带|吉他|贝斯|鼓|和声|词|曲|OP|SP)\s*[:：]/i;
const NCM_REQUEST_TIMEOUT_MS = 12_000;
const NCM_REQUEST_MAX_ATTEMPTS = 3;
const NCM_RETRY_BASE_DELAY_MS = 400;

interface NcmImportErrorOptions extends ErrorOptions {
  retryable?: boolean;
}

export class NcmImportError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: NcmImportErrorCode,
    message: string,
    options?: NcmImportErrorOptions
  ) {
    super(message, options);
    this.name = "NcmImportError";
    this.retryable = options?.retryable ?? false;
  }
}

export class NcmConnector {
  constructor(
    private readonly baseUrl: string,
    private readonly cookie: string | (() => string | undefined) | undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private makeUrl(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= NCM_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestJsonOnce<T>(path);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof NcmImportError) ||
          !error.retryable ||
          attempt === NCM_REQUEST_MAX_ATTEMPTS
        ) {
          throw error;
        }
        await delay(NCM_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }

  private async requestJsonOnce<T>(path: string): Promise<T> {
    const cookie = this.currentCookie();
    let response: Response;
    try {
      response = await this.fetchImpl(this.makeUrl(path), {
        headers: cookie ? { Cookie: cookie } : {},
        signal: AbortSignal.timeout(NCM_REQUEST_TIMEOUT_MS)
      });
    } catch (cause) {
      const causeName =
        cause && typeof cause === "object" && "name" in cause
          ? String(cause.name)
          : "";
      if (causeName === "TimeoutError" || causeName === "AbortError") {
        throw new NcmImportError(
          "ncm_request_failed",
          `网易云上游请求超时（${path}）。系统已自动重试，请稍后再试。`,
          { cause, retryable: true }
        );
      }
      throw new NcmImportError(
        "ncm_unreachable",
        `网易云 API 自动重试后仍无法连接（${this.baseUrl}）。请使用“一键启动.cmd”重新启动，或运行 npm run dev:ncm。`,
        { cause, retryable: true }
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw this.notLoggedInError();
      }
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      throw new NcmImportError(
        "ncm_request_failed",
        retryable
          ? `网易云上游暂时异常（HTTP ${response.status}，${path}）。系统已自动重试，请稍后再试。`
          : `网易云 API 请求失败（HTTP ${response.status}，${path}）。请重启 NCM API 后重试。`,
        { retryable }
      );
    }

    let payload: T;
    try {
      payload = (await response.json()) as T;
    } catch (cause) {
      throw new NcmImportError(
        "ncm_request_failed",
        `网易云 API 返回了无法解析的数据（${path}）。请重启 NCM API 后重试。`,
        { cause, retryable: true }
      );
    }

    const envelope = payload as { code?: number; msg?: string; message?: string };
    if (envelope.code === 301 || envelope.code === 302) {
      throw this.notLoggedInError();
    }
    if (typeof envelope.code === "number" && envelope.code >= 400) {
      const detail = envelope.msg ?? envelope.message;
      const retryable =
        envelope.code === 408 ||
        envelope.code === 429 ||
        envelope.code >= 500;
      throw new NcmImportError(
        "ncm_request_failed",
        `网易云 API 拒绝了请求（code=${envelope.code}${detail ? `，${detail}` : ""}）。`,
        { retryable }
      );
    }

    return payload;
  }

  async getUserId(): Promise<number> {
    const paths = [
      `/login/status?timestamp=${Date.now()}`,
      `/user/account?timestamp=${Date.now()}`
    ];
    let lastRequestError: NcmImportError | undefined;
    let authenticationError: NcmImportError | undefined;
    let receivedAccountPayload = false;

    for (const path of paths) {
      try {
        const response = await this.getJson<NcmAccountResponse>(path);
        const payload = response.data ?? response;
        receivedAccountPayload = true;
        const profileUserId = payload.profile?.userId;
        const isAnonymous =
          payload.account?.anonimousUser ?? payload.account?.anonymousUser;
        const status = payload.account?.status;

        if (profileUserId && isAnonymous !== true && status !== -10) {
          return profileUserId;
        }
      } catch (error) {
        if (error instanceof NcmImportError) {
          if (error.code === "ncm_not_logged_in") {
            authenticationError = error;
          }
          if (error.code === "ncm_unreachable") {
            throw authenticationError ?? error;
          }
          lastRequestError = error;
          continue;
        }
        throw error;
      }
    }

    if (receivedAccountPayload || authenticationError) {
      throw authenticationError ?? this.notLoggedInError();
    }
    throw lastRequestError ?? this.notLoggedInError();
  }

  async isReachable(): Promise<boolean> {
    try {
      const cookie = this.currentCookie();
      const response = await this.fetchImpl(
        this.makeUrl(`/login/status?timestamp=${Date.now()}`),
        {
          headers: cookie ? { Cookie: cookie } : {},
          signal: AbortSignal.timeout(5000)
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchUserMusicData(): Promise<TrackStat[]> {
    const cookie = this.currentCookie();
    if (!cookie?.trim() || /^PASTE_/i.test(cookie.trim())) {
      throw new NcmImportError(
        "ncm_cookie_missing",
        "尚未配置网易云登录 Cookie。请运行 npm run ncm:cookie，使用网易云音乐扫码登录。"
      );
    }

    const uid = await this.getUserId();

    const likes = await this.getJson<NcmLikeListResponse>(
      `/likelist?uid=${uid}&timestamp=${Date.now()}`
    );
    if (!Array.isArray(likes.ids)) {
      throw new NcmImportError(
        "ncm_request_failed",
        "网易云喜欢列表响应缺少 ids 字段。请重启固定版本的 NCM API 后重试。"
      );
    }
    const likedIds = likes.ids;
    const likedAtById = new Map<number, string>();
    const normalizedLikedIds: number[] = [];

    for (const entry of likedIds) {
      if (typeof entry === "number") {
        normalizedLikedIds.push(entry);
      } else if (entry && typeof entry.id === "number") {
        normalizedLikedIds.push(entry.id);
        if (entry.t) {
          likedAtById.set(entry.id, new Date(entry.t).toISOString());
        }
      }
    }

    if (normalizedLikedIds.length === 0) {
      throw new NcmImportError(
        "ncm_likes_empty",
        "网易云账号的“我喜欢的音乐”列表为空，当前没有可导入的曲目。"
      );
    }

    const details = await this.fetchSongDetails(normalizedLikedIds.slice(0, 1000));
    if (details.length === 0) {
      throw new NcmImportError(
        "ncm_track_details_empty",
        `网易云返回了 ${normalizedLikedIds.length} 个喜欢记录，但没有返回任何曲目详情。请重启 NCM API 后重试。`
      );
    }

    const record = await this.getJson<NcmUserRecordResponse>(
      `/user/record?uid=${uid}&type=0`
    ).catch(() => {
      console.warn("[NCM] Playback history unavailable; importing liked songs without play counts.");
      return { allData: [] };
    });
    const recordMap = new Map<number, UserRecordItem>();

    for (const row of record.allData ?? []) {
      if (row.song?.id) {
        recordMap.set(row.song.id, row);
      }
    }

    return details.map((track) => {
      const item = recordMap.get(track.id);
      const stat: TrackStat = {
        track: {
          ...track,
          moodTag: inferMood(track)
        },
        playCount: item?.playCount ?? 0
      };
      const likedAt = likedAtById.get(track.id);
      if (likedAt) {
        stat.likedAt = likedAt;
      }
      return stat;
    });
  }

  private notLoggedInError(): NcmImportError {
    return new NcmImportError(
      "ncm_not_logged_in",
      "网易云登录已失效或仍是匿名会话。请运行 npm run ncm:cookie，使用网易云音乐重新扫码登录。"
    );
  }

  private currentCookie(): string | undefined {
    return typeof this.cookie === "function" ? this.cookie() : this.cookie;
  }

  private async fetchSongDetails(ids: number[]): Promise<Track[]> {
    if (ids.length === 0) {
      return [];
    }
    const batchSize = 200;
    const tracks: Track[] = [];

    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const data = await this.getJson<NcmSongDetailResponse>(
        `/song/detail?ids=${chunk.join(",")}`
      );
      for (const song of data.songs ?? []) {
        const track: Track = {
          id: song.id,
          title: song.name,
          artists: (song.ar ?? []).map((artist) => artist.name)
        };
        if (song.al?.name) {
          track.album = song.al.name;
        }
        if (song.dt) {
          track.durationMs = song.dt;
        }
        if (song.al?.picUrl) {
          track.coverUrl = song.al.picUrl;
        }
        tracks.push(track);
      }
    }

    return tracks;
  }

  async resolveSongUrl(trackId: number): Promise<string | undefined> {
    try {
      const payload = await this.getJson<NcmSongUrlResponse>(
        `/song/url/v1?id=${trackId}&level=standard`
      );
      return payload.data?.[0]?.url;
    } catch {
      return undefined;
    }
  }

  async fetchLyrics(trackId: number): Promise<TrackLyrics> {
    try {
      const payload = await this.getJson<NcmLyricResponse>(`/lyric?id=${trackId}`);
      if (payload.nolyric === true) {
        return createPureMusicLyrics(trackId);
      }

      const originalLines = parseLrc(payload.lrc?.lyric);
      if (originalLines.length === 0) {
        return createPureMusicLyrics(trackId);
      }

      const translations = new Map(
        parseLrc(payload.tlyric?.lyric).map((line) => [line.timeMs, line.text])
      );
      const lines = originalLines.map((line) => {
        const translation = translations.get(line.timeMs);
        return translation ? { ...line, translation } : line;
      });

      return {
        trackId,
        pureMusic: false,
        lines
      };
    } catch {
      return createPureMusicLyrics(trackId);
    }
  }

  async searchSongs(keyword: string): Promise<Track[]> {
    if (!keyword.trim()) {
      return [];
    }
    const payload = await this.getJson<NcmSearchResponse>(
      `/cloudsearch?keywords=${encodeURIComponent(keyword)}&limit=8`
    );
    return (payload.result?.songs ?? []).map((song) => {
      const track: Track = {
        id: song.id,
        title: song.name,
        artists: (song.artists ?? []).map((artist) => artist.name)
      };
      if (song.album?.name) {
        track.album = song.album.name;
      }
      if (song.album?.picUrl) {
        track.coverUrl = song.album.picUrl;
      }
      if (song.duration) {
        track.durationMs = song.duration;
      }
      return track;
    });
  }
}

function createPureMusicLyrics(trackId: number): TrackLyrics {
  return {
    trackId,
    pureMusic: true,
    lines: []
  };
}

function parseLrc(raw: string | undefined): LyricLine[] {
  if (!raw) {
    return [];
  }
  const lines: LyricLine[] = [];
  const seen = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const timestamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (timestamps.length === 0) {
      continue;
    }
    const text = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    if (!text || METADATA_LINE_PATTERN.test(text)) {
      continue;
    }

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1]);
      const seconds = Number(timestamp[2]);
      const fraction = timestamp[3] ?? "0";
      const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
      const timeMs = minutes * 60_000 + seconds * 1000 + milliseconds;
      const key = `${timeMs}:${text}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      lines.push({ timeMs, text });
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
