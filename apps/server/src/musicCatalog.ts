import { createHash } from "node:crypto";

import type {
  EnvironmentContext,
  LibraryEvidence,
  MusicSource,
  MusicSourceStatus,
  Track,
  TrackKey,
  TrackLyrics
} from "@musicgpt/shared";

export interface MusicSourceSyncResult {
  source: MusicSource;
  tracks: Track[];
  evidence: LibraryEvidence[];
  warnings: string[];
}

export interface MusicSourceAdapter {
  readonly source: MusicSource;
  status(): Promise<MusicSourceStatus>;
  sync(): Promise<MusicSourceSyncResult>;
  search(query: string): Promise<Track[]>;
  recommend(context: EnvironmentContext): Promise<Track[]>;
  resolvePlayback(track: Track): Promise<string | undefined>;
  getLyrics(track: Track): Promise<TrackLyrics>;
}

export interface ResolvedPlayback {
  track: Track;
  url: string;
}

/**
 * Source-neutral music access. Callers learn one interface while provider
 * quirks, cross-source identity, dedupe and playback fallback stay local.
 */
export class MusicCatalog {
  private readonly adapters = new Map<MusicSource, MusicSourceAdapter>();
  private readonly variantsByRecording = new Map<string, Track[]>();
  private readonly playbackCooldownUntil = new Map<TrackKey, number>();
  private readonly fallbackDiscoveryCooldownUntil = new Map<string, number>();

  constructor(adapters: MusicSourceAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.source, adapter);
    }
  }

  async statuses(): Promise<MusicSourceStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.status()));
  }

  async sync(source: MusicSource): Promise<MusicSourceSyncResult> {
    const adapter = this.requireAdapter(source);
    const result = await adapter.sync();
    const tracks = this.registerMany(result.tracks, source);
    const byOriginalKey = new Map(
      result.tracks.map((track, index) => [getTrackKey(track, source), tracks[index]!])
    );
    return {
      ...result,
      tracks,
      evidence: result.evidence.map((evidence) => {
        const normalized = byOriginalKey.get(evidence.trackKey);
        return normalized
          ? {
              ...evidence,
              trackKey: normalized.trackKey!,
              recordingKey: normalized.recordingKey!
            }
          : evidence;
      })
    };
  }

  async search(query: string): Promise<Track[]> {
    const batches = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => ({
        source: adapter.source,
        tracks: await adapter.search(query).catch(() => [])
      }))
    );
    const registered = batches.flatMap(({ source, tracks }) => this.registerMany(tracks, source));
    return dedupeRecordings(registered);
  }

  async recommend(context: EnvironmentContext): Promise<Track[]> {
    const batches = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => ({
        source: adapter.source,
        tracks: await adapter.recommend(context).catch(() => [])
      }))
    );
    return dedupeRecordings(
      batches.flatMap(({ source, tracks }) => this.registerMany(tracks, source))
    );
  }

  registerTracks(tracks: Track[]): Track[] {
    return tracks.map((track) => this.register(track, inferSource(track)));
  }

  async resolvePlayback(track: Track): Promise<ResolvedPlayback | undefined> {
    const normalized = this.register(track, inferSource(track));
    const variants = this.orderedVariants(normalized);
    for (const variant of variants) {
      const variantKey = getTrackKey(variant);
      if ((this.playbackCooldownUntil.get(variantKey) ?? 0) > Date.now()) continue;
      const adapter = this.adapters.get(variant.source!);
      if (!adapter) {
        continue;
      }
      const url = await adapter.resolvePlayback(variant).catch(() => undefined);
      if (url) {
        this.playbackCooldownUntil.delete(variantKey);
        return { track: { ...variant, songUrl: url }, url };
      }
      this.playbackCooldownUntil.set(variantKey, Date.now() + 15 * 60_000);
    }
    const recordingKey = normalized.recordingKey!;
    if (
      normalized.source === "qq" &&
      (this.fallbackDiscoveryCooldownUntil.get(recordingKey) ?? 0) <= Date.now()
    ) {
      const fallback = this.adapters.get("ncm");
      const query = [normalized.title, ...normalized.artists].join(" ");
      const discovered = await fallback?.search(query).catch(() => []);
      if (fallback && discovered) {
        this.registerMany(discovered, "ncm");
        for (const variant of this.orderedVariants(normalized)) {
          if (variant.source !== "ncm") continue;
          const variantKey = getTrackKey(variant);
          if ((this.playbackCooldownUntil.get(variantKey) ?? 0) > Date.now()) continue;
          const url = await fallback.resolvePlayback(variant).catch(() => undefined);
          if (url) {
            this.playbackCooldownUntil.delete(variantKey);
            return { track: { ...variant, songUrl: url }, url };
          }
          this.playbackCooldownUntil.set(variantKey, Date.now() + 15 * 60_000);
        }
      }
      this.fallbackDiscoveryCooldownUntil.set(recordingKey, Date.now() + 15 * 60_000);
    }
    return undefined;
  }

  async getLyrics(track: Track): Promise<TrackLyrics> {
    const normalized = this.register(track, inferSource(track));
    for (const variant of this.orderedVariants(normalized)) {
      const adapter = this.adapters.get(variant.source!);
      if (!adapter) {
        continue;
      }
      const lyrics = await adapter.getLyrics(variant).catch(() => undefined);
      if (lyrics && (lyrics.pureMusic || lyrics.lines.length > 0)) {
        return { ...lyrics, trackId: normalized.trackKey! };
      }
    }
    return { trackId: normalized.trackKey!, pureMusic: true, lines: [] };
  }

  private requireAdapter(source: MusicSource): MusicSourceAdapter {
    const adapter = this.adapters.get(source);
    if (!adapter) {
      throw new Error(`music_source_unavailable:${source}`);
    }
    return adapter;
  }

  private registerMany(tracks: Track[], source: MusicSource): Track[] {
    return tracks.map((track) => this.register(track, source));
  }

  private register(track: Track, source: MusicSource): Track {
    const normalized = normalizeTrackIdentity(track, source);
    const baseKey = recordingBaseKey(normalized);
    const existingGroups = [...this.variantsByRecording.entries()]
      .filter(([key]) => key === baseKey || key.startsWith(`${baseKey}:`));
    const match = existingGroups.find(([, variants]) =>
      variants.some((variant) => isSameRecording(variant, normalized))
    );
    const recordingKey = match?.[0] ??
      (existingGroups.length === 0 ? baseKey : `${baseKey}:${durationDiscriminator(normalized)}`);
    const completed = { ...normalized, recordingKey };
    const variants = this.variantsByRecording.get(recordingKey) ?? [];
    const index = variants.findIndex((variant) => variant.trackKey === completed.trackKey);
    if (index >= 0) {
      variants[index] = { ...variants[index], ...completed };
    } else {
      variants.push(completed);
    }
    this.variantsByRecording.set(recordingKey, variants);
    return completed;
  }

  private orderedVariants(track: Track): Track[] {
    const variants = this.variantsByRecording.get(track.recordingKey!) ?? [track];
    return [track, ...variants.filter((variant) => variant.trackKey !== track.trackKey)];
  }
}

export function normalizeTrackIdentity(track: Track, fallbackSource: MusicSource = "ncm"): Track {
  const source = inferSource(track, fallbackSource);
  const sourceId = track.sourceId?.trim() || sourceIdFromTrack(track);
  const trackKey = `${source}:${sourceId}` as TrackKey;
  return {
    ...track,
    id: track.id ?? sourceId,
    trackKey,
    source,
    sourceId,
    recordingKey: track.recordingKey ?? recordingBaseKey(track)
  };
}

export function getTrackKey(track: Track, fallbackSource: MusicSource = "ncm"): TrackKey {
  return normalizeTrackIdentity(track, fallbackSource).trackKey!;
}

export function normalizeTrackReference(reference: string | number): TrackKey {
  if (typeof reference === "number") {
    return `ncm:${reference}`;
  }
  const trimmed = reference.trim();
  if (/^\d+$/.test(trimmed)) {
    return `ncm:${trimmed}`;
  }
  return trimmed.includes(":") ? trimmed : `ncm:${trimmed}`;
}

export function sourceIdFromKey(trackKey: TrackKey): string {
  return trackKey.slice(trackKey.indexOf(":") + 1);
}

function inferSource(track: Track, fallback: MusicSource = "ncm"): MusicSource {
  if (track.source) {
    return track.source;
  }
  if (track.trackKey?.startsWith("qq:")) {
    return "qq";
  }
  return fallback;
}

function sourceIdFromTrack(track: Track): string {
  if (track.trackKey?.includes(":")) {
    return sourceIdFromKey(track.trackKey);
  }
  return String(track.id);
}

function recordingBaseKey(track: Pick<Track, "title" | "artists">): string {
  const material = `${normalizeName(track.title)}|${track.artists.map(normalizeName).sort().join("|")}`;
  return `rec:${createHash("sha256").update(material).digest("hex").slice(0, 20)}`;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function durationDiscriminator(track: Track): string {
  return typeof track.durationMs === "number" ? String(Math.round(track.durationMs / 1_000)) : track.trackKey!;
}

function isSameRecording(left: Track, right: Track): boolean {
  if (normalizeName(left.title) !== normalizeName(right.title)) {
    return false;
  }
  if (left.artists.map(normalizeName).sort().join("|") !== right.artists.map(normalizeName).sort().join("|")) {
    return false;
  }
  if (typeof left.durationMs !== "number" || typeof right.durationMs !== "number") {
    return left.source === right.source && left.sourceId === right.sourceId;
  }
  return Math.abs(left.durationMs - right.durationMs) <= 5_000;
}

function dedupeRecordings(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.recordingKey!)) {
      return false;
    }
    seen.add(track.recordingKey!);
    return true;
  });
}
