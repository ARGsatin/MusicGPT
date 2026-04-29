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
  Track
} from "@musicgpt/shared";
import type { AiDjAssistant, AiDjContext, AiDjIntent, TrackSelection } from "./aiDjAssistant.js";
import { fallbackChatReply, fallbackClassify, fallbackComment } from "./aiDjAssistant.js";
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
    private readonly aiDjAssistant: AiDjAssistant,
    private readonly ttsPipeline: TtsPipeline,
    private readonly wsHub: WsHub,
    private readonly djBroadcastInterval: number,
    private readonly memoryTurns: number,
    private readonly importRetryIntervalMs: number = IMPORT_RETRY_INTERVAL_MS
  ) {}

  async initialize(): Promise<void> {
    this.state = this.repo.getNowPlaying() ?? { queue: [], paused: false };
    if (this.repo.getTrackStatsCount() === 0) {
      await this.runNcmImport();
    }
    await this.refreshTasteProfile();
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
      return { ok: true, importedCount, systemStatus };
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

  getChatHistory(): { messages: ChatResponse["messages"] } {
    return { messages: this.repo.getRecentMessages(this.chatHistoryLimit()) };
  }

  async getSystemStatus(): Promise<SystemStatus> {
    const aiDjStatus = this.aiDjAssistant.status();
    const status: SystemStatus = {
      runningRoot: process.cwd(),
      ncmReachable: await this.ncm.isReachable(),
      aiDjConfigured: aiDjStatus.configured,
      trackStatsCount: this.repo.getTrackStatsCount(),
      queueLength: this.state.queue.length
    };
    if (aiDjStatus.model) {
      status.aiDjModel = aiDjStatus.model;
    }
    if (typeof aiDjStatus.baseUrlConfigured === "boolean") {
      status.aiDjBaseUrlConfigured = aiDjStatus.baseUrlConfigured;
    }
    if (aiDjStatus.lastError) {
      status.aiDjLastError = aiDjStatus.lastError;
    }
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
    const resolved = await this.hydrateSongUrl(next);
    this.state.track = resolved.track;
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
    const context = this.buildAiContext();
    const intent = await this.classifySafely(message, context);

    switch (intent.type) {
      case "skip":
        if (this.state.track) {
          await this.handleFeedback({ type: "skip", trackId: this.state.track.id });
        }
        return this.reply("skip", "收到，切到下一首。", await this.nextTrack());
      case "pause":
        this.state.paused = true;
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("pause", "已暂停。你说继续，我就把夜色重新推上轨道。", this.state);
      case "resume":
        this.state.paused = false;
        if (!this.state.track) {
          await this.nextTrack();
        }
        this.repo.saveNowPlaying(this.state);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("resume", "继续播放。唱针已回到它该去的地方。", this.state);
      case "replan":
        this.desiredMood = intent.desiredMood;
        await this.nextTrack(true);
        this.wsHub.broadcast({ event: "now_playing_updated", data: this.state });
        return this.reply("replan", `已切到 ${intent.desiredMood} 风格，我继续按这个方向播。`, this.state);
      case "comment_current":
        return this.commentCurrentTrack(context);
      case "play_specific":
        return this.playSpecific(intent);
      case "play_by_description":
        return this.playByDescription(intent, context);
      case "chat":
      default: {
        const reply = await this.aiDjAssistant
          .chat(message, context)
          .catch(() => fallbackChatReply(message, context));
        return this.reply("noop", reply, this.state);
      }
    }
  }

  private async classifySafely(message: string, context: AiDjContext): Promise<AiDjIntent> {
    try {
      return await this.aiDjAssistant.classify(message, context);
    } catch {
      return fallbackClassify(message);
    }
  }

  private buildAiContext(): AiDjContext {
    return {
      messages: this.repo.getRecentMessages(this.chatHistoryLimit()),
      nowTrack: this.state.track,
      queue: this.state.queue.slice(0, 10),
      taste: this.repo.getTasteProfile()
    };
  }

  private chatHistoryLimit(): number {
    return Math.max(2, this.memoryTurns * 2);
  }

  private async playSpecific(intent: Extract<AiDjIntent, { type: "play_specific" }>): Promise<ChatResponse> {
    const query = intent.searchQuery?.trim() || intent.query.trim();
    const matches = await this.ncm.searchSongs(query);
    const target = matches[0];
    if (!target) {
      return this.reply("noop", `我没搜到「${query}」。换个歌名、歌手或给我一点氛围，我再挖。`, this.state);
    }
    this.state.queue.unshift({ track: target, score: 0.99, reason: `按你的指令点播：${query}` });
    const now = await this.nextTrack();
    const comment = await this.aiDjAssistant
      .commentTrack(target, this.buildAiContext(), `direct song request: ${query}`)
      .catch(() => fallbackComment(target));
    return this.reply("play_specific", `安排上了《${target.title}》 - ${target.artists.join(" / ")}。\n${comment}`, now);
  }

  private async playByDescription(
    intent: Extract<AiDjIntent, { type: "play_by_description" }>,
    context: AiDjContext
  ): Promise<ChatResponse> {
    const local = this.findLocalCandidates(intent.description);
    let candidates = local.map((candidate) => candidate.track);
    const bestLocalScore = local[0]?.score ?? 0;
    if (bestLocalScore < 0.35) {
      const searchQuery = intent.searchQuery?.trim() || intent.description;
      const remote = await this.ncm.searchSongs(searchQuery).catch(() => []);
      candidates = dedupeTracks([...candidates, ...remote]).slice(0, 12);
    }

    if (candidates.length === 0) {
      return this.reply("noop", "我暂时没有找到足够贴合的候选。再给我一点关键词，比如年代、男女声、节奏或情绪深浅。", this.state);
    }

    const selection = await this.aiDjAssistant
      .selectTrack(intent.description, candidates, context)
      .catch((): TrackSelection => ({ trackId: candidates[0]?.id, reason: "候选里它最贴近这次描述。" }));
    const target = candidates.find((track) => track.id === selection.trackId) ?? candidates[0];
    if (!target) {
      return this.reply("noop", "我暂时没有找到足够贴合的候选。再给我一点关键词，我会继续调频。", this.state);
    }

    this.state.queue.unshift({
      track: target,
      score: 0.99,
      reason: selection.reason || `按你的描述点播：${intent.description}`
    });
    const now = await this.nextTrack();
    const comment = await this.aiDjAssistant
      .commentTrack(target, this.buildAiContext(), `request description: ${intent.description}; selection reason: ${selection.reason}`)
      .catch(() => fallbackComment(target));
    return this.reply(
      "play_by_description",
      `我选《${target.title}》 - ${target.artists.join(" / ")}。\n${comment}`,
      now
    );
  }

  private async commentCurrentTrack(context: AiDjContext): Promise<ChatResponse> {
    if (!this.state.track) {
      return this.reply("comment_current", "现在还没有正在播放的歌。先点一首，我们再认真拆它的骨相。", this.state);
    }
    const reply = await this.aiDjAssistant.commentCurrent(context).catch(() => fallbackComment(this.state.track!));
    return this.reply("comment_current", reply, this.state);
  }

  private findLocalCandidates(description: string): Array<{ track: Track; score: number }> {
    return this.repo
      .getTrackStats(800)
      .map((entry) => ({
        track: entry.track,
        score: scoreTrackForDescription(entry, description)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
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

  private async hydrateSongUrl(item: RadioPlanItem): Promise<RadioPlanItem> {
    if (item.track.songUrl) {
      return item;
    }
    const songUrl = await this.ncm.resolveSongUrl(item.track.id);
    if (!songUrl) {
      return item;
    }
    this.repo.patchTrackSongUrl(item.track.id, songUrl);
    return {
      ...item,
      track: {
        ...item.track,
        songUrl
      }
    };
  }

  private reply(action: ChatResponse["action"], reply: string, now: NowPlayingState): ChatResponse {
    this.repo.addChatMessage({ role: "assistant", text: reply, at: new Date().toISOString() });
    return {
      action,
      reply,
      now,
      messages: this.repo.getRecentMessages(this.chatHistoryLimit())
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

function dedupeTracks(items: Track[]): Track[] {
  const seen = new Set<number>();
  const output: Track[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

function scoreTrackForDescription(entry: { track: Track; playCount: number }, description: string): number {
  const text = `${entry.track.title} ${entry.track.artists.join(" ")} ${entry.track.album ?? ""}`.toLowerCase();
  const desc = description.toLowerCase();
  let score = Math.min(0.2, entry.playCount / 500);

  const rules: Array<{ pattern: RegExp; moods: string[]; words: string[]; weight: number }> = [
    { pattern: /雨|rain|下雨/, moods: ["calm", "night", "warm"], words: ["rain", "雨"], weight: 0.28 },
    { pattern: /夜|凌晨|深夜|晚|night|midnight/, moods: ["night"], words: ["night", "midnight", "nocturne", "deep"], weight: 0.45 },
    { pattern: /代码|工作|学习|专注|focus|coding/, moods: ["focus"], words: ["focus", "code", "work"], weight: 0.45 },
    { pattern: /电子|低频|edm|bass|electro/, moods: ["energy", "focus"], words: ["bass", "electro", "edm", "synth"], weight: 0.35 },
    { pattern: /散步|安静|平静|calm|walk/, moods: ["calm", "night", "warm"], words: ["walk", "quiet", "calm"], weight: 0.25 },
    { pattern: /怀旧|经典|nostalgia|old/, moods: ["nostalgia"], words: ["old", "classic"], weight: 0.32 }
  ];

  for (const rule of rules) {
    if (!rule.pattern.test(desc)) {
      continue;
    }
    if (entry.track.moodTag && rule.moods.includes(entry.track.moodTag)) {
      score += rule.weight;
    }
    if (rule.words.some((word) => text.includes(word))) {
      score += rule.weight;
    }
  }

  for (const token of desc.split(/\s+/).filter((part) => part.length >= 2)) {
    if (text.includes(token)) {
      score += 0.2;
    }
  }

  return score;
}
