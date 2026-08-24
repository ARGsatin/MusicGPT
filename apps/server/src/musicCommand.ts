import type {
  MusicCommandRequest,
  MusicCommandResult,
  NowPlayingState,
  Track,
  TrackReference
} from "@musicgpt/shared";

import type { AiDjIntent } from "./aiDjAssistant.js";
import { getTrackKey, normalizeTrackReference } from "./musicCatalog.js";
import { StateRepository } from "./stateRepository.js";

const CONFIRMATION_TTL_MS = 120_000;

export interface MusicCommandRuntime {
  getNow(): NowPlayingState;
  classify(request: string): Promise<AiDjIntent>;
  searchSongs(query: string): Promise<Track[]>;
  playTrack(track: Track, reason: string): Promise<NowPlayingState>;
  setFavorite(trackId: TrackReference, favorite: boolean): Promise<void>;
  replay(trackId: TrackReference): Promise<void>;
  handleIntent(
    request: string,
    intent: AiDjIntent,
    mode: MusicCommandRequest["mode"]
  ): Promise<MusicCommandResult>;
}

export class MusicCommandModule {
  private readonly inFlight = new Map<string, Promise<MusicCommandResult>>();

  constructor(
    private readonly repo: StateRepository,
    private readonly runtime?: MusicCommandRuntime
  ) {}

  async execute(
    request: MusicCommandRequest,
    run?: (confirmedTrack?: Track) => Promise<MusicCommandResult>
  ): Promise<MusicCommandResult> {
    const cached = this.repo.getConversationToolCall(request.commandId);
    if (cached) return cached.result as MusicCommandResult;
    const pending = this.inFlight.get(request.commandId);
    if (pending) return pending;

    const execution = this.executeFresh(request, run);
    this.inFlight.set(request.commandId, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(request.commandId);
    }
  }

  private async executeFresh(
    request: MusicCommandRequest,
    run?: (confirmedTrack?: Track) => Promise<MusicCommandResult>
  ): Promise<MusicCommandResult> {
    let confirmedTrack: Track | undefined;
    if (request.confirmationToken) {
      const confirmation = this.repo.getConversationToolCall(request.confirmationToken);
      const result = confirmation?.result as MusicCommandResult | undefined;
      const createdAt = confirmation ? Date.parse(confirmation.createdAt) : Number.NaN;
      confirmedTrack = result?.candidates?.find(
        (track) =>
          request.selectedTrackId !== undefined &&
          normalizeTrackReference(track.id) === normalizeTrackReference(request.selectedTrackId)
      );
      if (
        !confirmation ||
        confirmation.consumedAt ||
        !Number.isFinite(createdAt) ||
        Date.now() - createdAt > CONFIRMATION_TTL_MS ||
        result?.outcome !== "needs_confirmation" ||
        !confirmedTrack
      ) {
        return invalidConfirmation(result?.now, "这次点歌确认已经失效，请重新说一次。");
      }
      if (!this.repo.consumeConversationToolCall(request.confirmationToken)) {
        return invalidConfirmation(result?.now, "这次点歌确认已经使用过了，请重新说一次。");
      }
    }

    const result = run
      ? await run(confirmedTrack)
      : await this.executeDomain(request, confirmedTrack);
    this.repo.saveConversationToolCall({
      commandId: request.commandId,
      turnId: request.turnId,
      toolName: "run_music_command",
      request,
      result,
      createdAt: new Date().toISOString()
    });
    return result;
  }

  private async executeDomain(
    request: MusicCommandRequest,
    confirmedTrack?: Track
  ): Promise<MusicCommandResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("music_command_runtime_unavailable");
    if (confirmedTrack) {
      const now = await runtime.playTrack(confirmedTrack, "语音确认点歌");
      return executedTrack(confirmedTrack, now);
    }

    const text = request.request.trim();
    const now = runtime.getNow();
    const current = now.track;
    if (/队列|接下来|后面.*(?:歌|曲)/u.test(text) && /什么|哪些|看看|告诉/u.test(text)) {
      const titles = now.queue.slice(0, 5).map((item) => `《${item.track.title}》`).join("、");
      return {
        action: "query_queue",
        outcome: "answered",
        summary: titles ? `接下来是 ${titles}。` : "当前播放队列还是空的。",
        now
      };
    }
    if (/当前|这首|现在/u.test(text) && /什么歌|哪首|歌名|谁唱/u.test(text)) {
      return {
        action: "query_current",
        outcome: "answered",
        summary: current ? `现在是《${current.title}》— ${formatArtists(current)}。` : "当前没有歌曲在播放。",
        now
      };
    }
    if (/取消收藏|不喜欢|别收藏/u.test(text) && current) {
      await runtime.setFavorite(getTrackKey(current), false);
      return { action: "unlike", outcome: "executed", summary: "已取消收藏这首歌。", now: runtime.getNow() };
    }
    if (/收藏|喜欢这首|标记喜欢/u.test(text) && current) {
      await runtime.setFavorite(getTrackKey(current), true);
      return { action: "like", outcome: "executed", summary: "已收藏这首歌。", now: runtime.getNow() };
    }
    if (/重播|再放一遍|从头/u.test(text) && current) {
      await runtime.replay(getTrackKey(current));
      return { action: "replay", outcome: "executed", summary: "已从头重播。", now: runtime.getNow() };
    }

    const intent = await runtime.classify(text);
    if (request.mode === "text_suggest") return runtime.handleIntent(text, intent, request.mode);
    if (intent.type !== "play_specific") return runtime.handleIntent(text, intent, request.mode);

    const query = intent.searchQuery?.trim() || intent.query.trim();
    const matches = await runtime.searchSongs(query);
    if (matches.length === 0) {
      return { action: "play_specific", outcome: "failed", summary: `没有搜到《${query}》。`, now: runtime.getNow() };
    }
    const candidates = matches.slice(0, 3);
    if (!isConfidentVoiceMatch(query, candidates)) {
      return {
        action: "play_specific",
        outcome: "needs_confirmation",
        summary: `我找到了 ${candidates.map((track) => `《${track.title}》`).join("、")}，你想听哪一首？`,
        now: runtime.getNow(),
        candidates,
        confirmationToken: request.commandId
      };
    }
    const target = candidates[0]!;
    const next = await runtime.playTrack(target, "语音点歌");
    return executedTrack(target, next);
  }
}

function invalidConfirmation(now: NowPlayingState | undefined, summary: string): MusicCommandResult {
  return { action: "noop", outcome: "failed", summary, now: now ?? { queue: [], paused: false } };
}

function executedTrack(track: Track, now: NowPlayingState): MusicCommandResult {
  return {
    action: "play_specific",
    outcome: "executed",
    summary: `已播放《${track.title}》— ${formatArtists(track)}。`,
    now
  };
}

function isConfidentVoiceMatch(query: string, candidates: Track[]): boolean {
  const normalized = normalizeMatchText(query);
  if (!normalized || candidates.length <= 1) return candidates.length > 0;
  const first = candidates[0];
  if (!first) return false;
  const exactTitle = normalizeMatchText(first.title) === normalized;
  const artistMatch = first.artists.some((artist) => {
    const normalizedArtist = normalizeMatchText(artist);
    return normalizedArtist === normalized || normalized.includes(normalizedArtist);
  });
  const allSameArtist = candidates.every((track) =>
    track.artists.some((artist) => normalizeMatchText(artist) === normalized)
  );
  return exactTitle || artistMatch || allSameArtist;
}

function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/[\s《》「」“”"'·,，。.!！?？-]/gu, "");
}

function formatArtists(track: Track): string {
  return track.artists.length > 0 ? track.artists.join(" / ") : "未知艺术家";
}
