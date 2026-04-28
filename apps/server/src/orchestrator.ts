import { createExtensionProviders } from "./providers.js";

import type {
  ChatResponse,
  FeedbackRequest,
  ImportNcmResponse,
  NowPlayingState,
  PlayEvent,
  RadioPlanItem,
  SystemStatus,
  TasteProfile,
  Track,
  TrackLyrics
} from "@musicgpt/shared";
import { DjBrain } from "./djBrain.js";
import { NcmConnector } from "./ncmConnector.js";
import { RadioPlanner } from "./radioPlanner.js";
import { StateRepository } from "./stateRepository.js";
import { TasteEngine } from "./tasteEngine.js";
import { TtsPipeline } from "./ttsPipeline.js";
import { WsHub } from "./wsHub.js";

const PLAN_WINDOW_SIZE = 10;
const QUEUE_TARGET_SIZE = 10;
const QUEUE_REFILL_THRESHOLD = 6;
const IMPORT_RETRY_INTERVAL_MS = 60_000;
const EMPTY_IMPORT_ERROR = "未导入到有效曲目，请检查 NCM API 与登录 Cookie。";

export class RadioOrchestrator {
  private state: NowPlayingState = { queue: [], paused: false };
  private desiredMood?: string;
  private completedTracksSinceLastDj = 0;
  private importRetryTimer: ReturnType<typeof setInterval> | undefined;
  private importInFlight = false;
  private lastImportAt: string | undefined;
  private lastImportError: string | undefined;

  constructor(
    private readonly repo: StateRepository,
    private readonly ncm: NcmConnector,
    private readonly tasteEngine: TasteEngine,
    private readonly planner: RadioPlanner,
    private readonly djBrain: DjBrain,
    private readonly ttsPipeline: TtsPipeline,
    private readonly wsHub: WsHub,
    private readonly djBroadcastInterval: number,
    private readonly importRetryIntervalMs: number = IMPORT_RETRY_INTERVAL_MS
  ) {}

  async initialize(): Promise<void> {
    this.state = this.repo.getNowPlaying() ?? { queue: [], paused: false };
    if (this.repo.getTrackStatsCount() === 0) {
      await this.runNcmImport();
    }
    await this.refreshTasteProfile();
    if (this.state.track && this.state.lyrics?.trackId !== this.state.track.id) {
      this.state.lyrics = await this.ncm.fetchLyrics(this.state.track.id);
      this.repo.saveNowPlaying(this.state);
    }
    await this.ensureQueue();
    if (!this.state.track && this.state.queue.length > 0) {
      await this.nextTrack();
    }
    this.startImportRetryLoop();

    for (const provider of createExtensionProviders()) {
      await provider.refresh().catch(() => undefined);
    }
    await this.broadcastSystemStatus();
  }

  close(): void {
    this.stopImportRetryLoop();
  }

  async importFromNcm(): Promise<number> {
    return this.runNcmImport();
  }

  async importFromNcmAndRefresh(): Promise<ImportNcmResponse> {
    const importedCount = await this.runNcmImport();
    if (importedCount > 0) {
      await this.postImportRefresh();
      this.stopImportRetryLoop();
    } else {
      this.startImportRetryLoop();
    }
    await this.broadcastSystemStatus();
    const systemStatus = await this.getSystemStatus();
    if (importedCount > 0) {
      return {
        ok: true,
        importedCount,
        systemStatus
      };
    }
    return {
      ok: false,
      importedCount,
      error: this.lastImportError ?? EMPTY_IMPORT_ERROR,
      systemStatus
    };
  }

  getNow(): NowPlayingState {
    return this.state;
  }

  getTaste(): TasteProfile | undefined {
    return this.repo.getTasteProfile();
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const status: SystemStatus = {
      runningRoot: process.cwd(),
      ncmReachable: await this.ncm.isReachable(),
      trackStatsCount: this.repo.getTrackStatsCount(),
      queueLength: this.state.queue.length
    };
    if (this.lastImportAt) {
      status.lastImportAt = this.lastImportAt;
    }
    if (this.lastImportError) {
      status.lastImportError = this.lastImportError;
    }
    return status;
  }

  async refreshTasteProfile(): Promise<TasteProfile> {
    const profile = this.tasteEngine.generate(
      this.repo.getTrackStats(),
      this.repo.getRecentPlayEvents(200)
    );
    this.repo.saveTasteProfile(profile);
    return profile;
  }

  async ensureQueue(): Promise<void> {
    if (this.state.queue.length >= QUEUE_REFILL_THRESHOLD) {
      return;
    }
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const planOptions = this.desiredMood
      ? { windowSize: PLAN_WINDOW_SIZE, desiredMood: this.desiredMood }
      : { windowSize: PLAN_WINDOW_SIZE };
    const planned = this.planner.plan(
      this.repo.getTrackStats(),
      profile,
      this.repo.getRecentPlayEvents(120),
      planOptions
    );
    this.state.queue = dedupeByTrackId([...this.state.queue, ...planned]).slice(0, QUEUE_TARGET_SIZE);
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  async nextTrack(forceReplan = false): Promise<NowPlayingState> {
    if (forceReplan) {
      this.state.queue = [];
    }
    await this.ensureQueue();
    const next = this.state.queue.shift();
    if (!next) {
      return this.state;
    }
    const resolved = await this.hydrateTrack(next);
    this.state.track = resolved.item.track;
    this.state.lyrics = resolved.lyrics;
    this.state.startedAt = new Date().toISOString();
    this.state.paused = false;

    await this.ensureQueue();

    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    return this.state;
  }

  async handleFeedback(feedback: FeedbackRequest): Promise<void> {
    const event: PlayEvent = {
      type: feedback.type,
      trackId: feedback.trackId,
      at: new Date().toISOString()
    };
    this.repo.addPlayEvent(event);
    if (feedback.type === "like") {
      this.repo.markTrackLiked(feedback.trackId, event.at);
    }
    if (feedback.type === "complete") {
      this.completedTracksSinceLastDj += 1;
      await this.maybeGenerateDj();
    }
    if (feedback.type === "replay") {
      this.state.paused = false;
      this.state.startedAt = event.at;
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
    }
    await this.refreshTasteProfile();
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  async handleChat(message: string): Promise<ChatResponse> {
    this.repo.addChatMessage({ role: "user", text: message, at: new Date().toISOString() });
    const lower = message.toLowerCase();

    if (/\b(skip|next|下一首|切歌)\b/.test(lower) || /下一首|切歌/.test(message)) {
      if (this.state.track) {
        await this.handleFeedback({ type: "skip", trackId: this.state.track.id });
      }
      const now = await this.nextTrack();
      return this.reply("skip", "收到，切到下一首。", now);
    }

    if (/暂停|pause/.test(message)) {
      this.state.paused = true;
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
      return this.reply("pause", "已暂停，你说继续我就接着播。", this.state);
    }

    if (/继续|resume|播放/.test(message)) {
      this.state.paused = false;
      if (!this.state.track) {
        await this.nextTrack();
      }
      this.repo.saveNowPlaying(this.state);
      this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
      return this.reply("resume", "已恢复播放。", this.state);
    }

    const desiredMood = this.extractMood(message);
    if (desiredMood) {
      this.desiredMood = desiredMood;
      const now = await this.nextTrack(true);
      return this.reply("replan", `已切到${desiredMood}风格，我继续按这个方向播。`, now);
    }

    const playSpecific = this.extractPlayKeyword(message);
    if (playSpecific) {
      const matches = await this.ncm.searchSongs(playSpecific);
      const target = matches[0];
      if (target) {
        this.state.queue.unshift({ track: target, score: 0.99, reason: `按你的指令点播：${playSpecific}` });
        const now = await this.nextTrack();
        return this.reply("play_specific", `安排上了《${target.title}》。`, now);
      }
    }

    await this.ensureQueue();
    return this.reply("noop", "我在，想点歌、换风格或切歌都可以直接说。", this.state);
  }

  private async maybeGenerateDj(): Promise<void> {
    if (this.completedTracksSinceLastDj < this.djBroadcastInterval) {
      return;
    }
    if (!this.state.track) {
      return;
    }
    const profile = this.repo.getTasteProfile() ?? (await this.refreshTasteProfile());
    const script = await this.djBrain.generate({
      profile,
      nowTrack: this.state.track,
      upcoming: this.state.queue.slice(0, 3)
    });
    const voiced = await this.ttsPipeline.synthesize(script);
    this.state.djScript = voiced;
    this.repo.saveDjScript(voiced);
    this.wsHub.broadcast({ event: "dj_tts_ready", data: voiced });
    this.completedTracksSinceLastDj = 0;
  }

  private startImportRetryLoop(): void {
    if (this.importRetryTimer) {
      return;
    }
    if (this.repo.getTrackStatsCount() > 0) {
      return;
    }
    this.importRetryTimer = setInterval(() => {
      void this.retryImportIfNeeded();
    }, this.importRetryIntervalMs);
    this.importRetryTimer.unref?.();
  }

  private stopImportRetryLoop(): void {
    if (!this.importRetryTimer) {
      return;
    }
    clearInterval(this.importRetryTimer);
    this.importRetryTimer = undefined;
  }

  private async retryImportIfNeeded(): Promise<void> {
    if (this.repo.getTrackStatsCount() > 0) {
      this.stopImportRetryLoop();
      return;
    }
    const importedCount = await this.runNcmImport();
    if (importedCount > 0) {
      await this.postImportRefresh();
      this.stopImportRetryLoop();
    }
    await this.broadcastSystemStatus();
  }

  private async runNcmImport(): Promise<number> {
    if (this.importInFlight) {
      this.lastImportError = "导入任务正在进行中。";
      return 0;
    }

    this.importInFlight = true;
    this.lastImportAt = new Date().toISOString();
    try {
      const stats = await this.ncm.fetchUserMusicData();
      if (stats.length === 0) {
        this.lastImportError = EMPTY_IMPORT_ERROR;
        return 0;
      }
      this.repo.upsertTrackStats(stats);
      this.lastImportError = undefined;
      return stats.length;
    } catch (error) {
      this.lastImportError = error instanceof Error ? error.message : String(error);
      return 0;
    } finally {
      this.importInFlight = false;
    }
  }

  private async postImportRefresh(): Promise<void> {
    await this.refreshTasteProfile();
    await this.ensureQueue();
    if (!this.state.track && this.state.queue.length > 0) {
      await this.nextTrack();
      return;
    }
    this.repo.saveNowPlaying(this.state);
    this.wsHub.broadcast({ event: "queue_updated", data: this.state.queue });
  }

  private async broadcastSystemStatus(): Promise<void> {
    this.wsHub.broadcast({ event: "system_status", data: await this.getSystemStatus() });
  }

  private async hydrateTrack(item: RadioPlanItem): Promise<{ item: RadioPlanItem; lyrics: TrackLyrics }> {
    const lyrics = await this.ncm.fetchLyrics(item.track.id);
    if (item.track.songUrl) {
      return { item, lyrics };
    }
    const songUrl = await this.ncm.resolveSongUrl(item.track.id);
    if (!songUrl) {
      return { item, lyrics };
    }
    this.repo.patchTrackSongUrl(item.track.id, songUrl);
    return {
      item: {
        ...item,
        track: {
          ...item.track,
          songUrl
        }
      },
      lyrics
    };
  }

  private extractMood(text: string): string | undefined {
    const moodMap: Array<{ mood: string; keywords: RegExp }> = [
      { mood: "calm", keywords: /轻松|舒缓|平静|calm/i },
      { mood: "energy", keywords: /燃|动感|摇滚|edm|energy/i },
      { mood: "night", keywords: /夜晚|深夜|晚安|night/i },
      { mood: "focus", keywords: /专注|学习|工作|focus/i },
      { mood: "nostalgia", keywords: /怀旧|经典|old/i },
      { mood: "warm", keywords: /治愈|温柔|暖/i }
    ];

    for (const item of moodMap) {
      if (item.keywords.test(text)) {
        return item.mood;
      }
    }
    return undefined;
  }

  private extractPlayKeyword(text: string): string | undefined {
    const match = text.match(/来一首(.+)/) ?? text.match(/播放(.+)/);
    if (!match) {
      return undefined;
    }
    return match[1]?.trim();
  }

  private reply(action: ChatResponse["action"], reply: string, now: NowPlayingState): ChatResponse {
    this.repo.addChatMessage({ role: "assistant", text: reply, at: new Date().toISOString() });
    return {
      action,
      reply,
      now
    };
  }
}

function dedupeByTrackId(items: RadioPlanItem[]): RadioPlanItem[] {
  const seen = new Set<number>();
  const output: RadioPlanItem[] = [];
  for (const item of items) {
    if (seen.has(item.track.id)) {
      continue;
    }
    seen.add(item.track.id);
    output.push(item);
  }
  return output;
}
