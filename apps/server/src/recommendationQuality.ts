import type { Track } from "@musicgpt/shared";

const AMBIENT_TRACK_PATTERN =
  /(白噪音|粉红噪音|棕色噪音|asmr|助眠|睡眠音|环境音|自然音|雨声|雷雨声|海浪声|篝火声|作业用\s*bgm|カフェ\s*bgm|睡眠用)/i;

const EXPLICIT_AMBIENT_REQUEST_PATTERN =
  /(白噪音|粉红噪音|棕色噪音|asmr|助眠|睡眠|环境音|自然音|雨声|雷雨声|海浪声|篝火声)/i;

export function hasRecommendationMetadata(track: Track): boolean {
  const title = typeof track.title === "string" ? track.title.trim() : "";
  const hasArtist = Array.isArray(track.artists) && track.artists.some(
    (artist) => typeof artist === "string" && Boolean(artist.trim())
  );
  const hasId = typeof track.id === "number"
    ? Number.isFinite(track.id) && track.id > 0
    : track.id.trim().length > 0;
  return hasId && Boolean(
    title && title.toLowerCase() !== "unknown" && hasArtist
  );
}

export function isAmbientTrack(track: Track): boolean {
  return AMBIENT_TRACK_PATTERN.test(`${track.title} ${track.album ?? ""}`);
}

export function isExplicitAmbientRequest(text: string): boolean {
  return EXPLICIT_AMBIENT_REQUEST_PATTERN.test(text);
}

export function isEligibleRecommendationTrack(track: Track, allowAmbient = false): boolean {
  return hasRecommendationMetadata(track) && (allowAmbient || !isAmbientTrack(track));
}
