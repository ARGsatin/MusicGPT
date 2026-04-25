import { inferMood } from "./moodClassifier.js";

import type { Track, TrackStat } from "@musicgpt/shared";

interface NcmAccountResponse {
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

export class NcmConnector {
  constructor(
    private readonly baseUrl: string,
    private readonly cookie?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private makeUrl(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(this.makeUrl(path), {
      headers: this.cookie ? { Cookie: this.cookie } : {}
    });
    if (!response.ok) {
      throw new Error(`NCM request failed: ${response.status} ${path}`);
    }
    return (await response.json()) as T;
  }

  async getUserId(): Promise<number | undefined> {
    try {
      const payload = await this.getJson<NcmAccountResponse>("/user/account");
      const profileUserId = payload.profile?.userId;
      const accountId = payload.account?.id;
      const userId = profileUserId ?? accountId;
      const isAnonymous = payload.account?.anonimousUser ?? payload.account?.anonymousUser;
      const status = payload.account?.status;

      if (!profileUserId) {
        console.warn("[NCM] /user/account missing profile.userId. Cookie may be invalid.");
        return undefined;
      }
      if (isAnonymous === true || status === -10) {
        console.warn("[NCM] /user/account is anonymous or invalid session. Please refresh NCM_COOKIE.");
        return undefined;
      }
      if (!userId) {
        console.warn("[NCM] /user/account missing user id. Please refresh NCM_COOKIE.");
        return undefined;
      }

      return userId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NCM] Failed to fetch /user/account: ${message}`);
      return undefined;
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(
        this.makeUrl(`/login/status?timestamp=${Date.now()}`),
        {
          headers: this.cookie ? { Cookie: this.cookie } : {},
          signal: AbortSignal.timeout(5000)
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetchUserMusicData(): Promise<TrackStat[]> {
    const uid = await this.getUserId();
    if (!uid) {
      return [];
    }

    const likes = await this.getJson<NcmLikeListResponse>(
      `/likelist?uid=${uid}&timestamp=${Date.now()}`
    );
    const likedIds = likes.ids ?? [];
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

    const details = await this.fetchSongDetails(normalizedLikedIds.slice(0, 1000));
    const record = await this.getJson<NcmUserRecordResponse>(`/user/record?uid=${uid}&type=0`);
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
