import type {
  EnvironmentContext,
  LibraryEvidence,
  MusicSourceStatus,
  Track,
  TrackLyrics
} from "@musicgpt/shared";

import type { MusicSourceAdapter, MusicSourceSyncResult } from "./musicCatalog.js";
import { normalizeTrackIdentity } from "./musicCatalog.js";
import { NcmConnector } from "./ncmConnector.js";

export class NcmMusicAdapter implements MusicSourceAdapter {
  readonly source = "ncm" as const;
  private lastSyncAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly connector: NcmConnector) {}

  async status(): Promise<MusicSourceStatus> {
    const reachable = await this.connector.isReachable();
    return {
      source: "ncm",
      enabled: true,
      connected: reachable && !this.lastError,
      ...(this.lastSyncAt ? { lastSyncAt: this.lastSyncAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      capabilities: {
        accountLibrary: true,
        recentPlays: true,
        search: true,
        recommendations: true,
        playback: true,
        lyrics: true
      }
    };
  }

  async sync(): Promise<MusicSourceSyncResult> {
    try {
      const stats = await this.connector.fetchUserMusicData();
      const observedAt = new Date().toISOString();
      const tracks = stats.map((stat) => normalizeTrackIdentity(stat.track));
      const evidence: LibraryEvidence[] = stats.flatMap((stat, index) => {
        const track = tracks[index]!;
        const items: LibraryEvidence[] = [];
        if (stat.likedAt) {
          items.push({
            trackKey: track.trackKey!,
            recordingKey: track.recordingKey!,
            source: "ncm",
            kind: "platform_like",
            observedAt: stat.likedAt
          });
        }
        if (stat.playCount > 0) {
          items.push({
            trackKey: track.trackKey!,
            recordingKey: track.recordingKey!,
            source: "ncm",
            kind: "recent_play",
            observedAt,
            playCount: stat.playCount
          });
        }
        return items;
      });
      this.lastSyncAt = observedAt;
      this.lastError = undefined;
      return { source: "ncm", tracks, evidence, warnings: [] };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  search(query: string): Promise<Track[]> {
    return this.connector.searchSongs(query);
  }

  recommend(_context: EnvironmentContext): Promise<Track[]> {
    return this.connector.fetchDailyRecommendations();
  }

  resolvePlayback(track: Track): Promise<string | undefined> {
    const id = ncmId(track);
    return id === undefined ? Promise.resolve(undefined) : this.connector.resolveSongUrl(id);
  }

  getLyrics(track: Track): Promise<TrackLyrics> {
    const id = ncmId(track);
    return id === undefined
      ? Promise.resolve({ trackId: track.trackKey ?? String(track.id), pureMusic: true, lines: [] })
      : this.connector.fetchLyrics(id);
  }
}

function ncmId(track: Track): number | undefined {
  const value = Number(track.sourceId ?? track.id);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
