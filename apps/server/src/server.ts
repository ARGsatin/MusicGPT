import path from "node:path";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";

import { config, readCurrentNcmCookie } from "./config.js";
import type {
  FeedbackRequest,
  MusicSource,
  PlaybackOutcomeRequest,
  TasteSignalMutationRequest,
  Track,
  TrackReference
} from "@musicgpt/shared";
import type { AiDjAssistant } from "./aiDjAssistant.js";
import { OpenAiDjAssistant } from "./aiDjAssistant.js";
import { DjBrain } from "./djBrain.js";
import type { EnvironmentService } from "./environmentService.js";
import { EnvironmentService as OpenMeteoEnvironmentService } from "./environmentService.js";
import { NcmConnector } from "./ncmConnector.js";
import { ListeningPolicy } from "./listeningPolicy.js";
import { NcmMusicAdapter } from "./ncmMusicAdapter.js";
import { MusicCatalog, normalizeTrackReference, sourceIdFromKey } from "./musicCatalog.js";
import { QqMusicAdapter } from "./qqMusicAdapter.js";
import { DailyPlanEngine } from "./dailyPlan.js";
import { LocalRoutineProvider, type RoutineProvider } from "./routineProvider.js";
import { TasteDocumentManager } from "./tasteDocuments.js";
import { TrackTagEnricher, createAiTagCompleter } from "./trackTagEnricher.js";
import { QueuedTrackPlaybackError, RadioOrchestrator } from "./orchestrator.js";
import { RadioPlanner } from "./radioPlanner.js";
import {
  buildRealtimeSessionConfig,
  createRealtimeSession,
  isRealtimeSessionConfigured,
  REALTIME_MODEL,
  REALTIME_VOICE
} from "./realtimeSession.js";
import { RecommendationImporter } from "./recommendationImporter.js";
import { StateRepository } from "./stateRepository.js";
import { TasteEngine } from "./tasteEngine.js";
import { WsHub } from "./wsHub.js";

const chatSchema = z.object({
  message: z.string().min(1),
  turnId: z.string().min(1).max(200).optional()
});

const chatStreamSchema = chatSchema;

const chatMemoryParamsSchema = z.object({
  memoryId: z.coerce.number().int().positive()
});

const realtimeSessionQuerySchema = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  baselineRevision: z.coerce.number().int().min(0).optional()
});

const realtimeErrorSchema = z.object({ code: z.string().min(1).max(200) });

const voiceTurnSchema = z.object({
  sessionId: z.string().min(1).max(200),
  clientTurnId: z.string().min(1).max(200),
  transcript: z.string().min(1).max(20_000),
  at: z.string().datetime()
});

const voiceTurnParamsSchema = z.object({ turnId: z.string().min(1).max(500) });

const voiceTurnCompleteSchema = z.object({
  transcript: z.string().max(30_000).optional(),
  model: z.string().min(1).max(200),
  responseId: z.string().max(200).optional(),
  status: z.enum(["completed", "interrupted", "failed"]),
  at: z.string().datetime()
});

const musicCommandSchema = z.object({
  turnId: z.string().min(1).max(500),
  commandId: z.string().min(1).max(200),
  request: z.string().min(1).max(20_000),
  mode: z.enum(["text_suggest", "voice_direct"]),
  confirmationToken: z.string().min(1).max(200).optional(),
  selectedTrackId: z.union([z.string().min(1), z.number().int()]).optional()
});

const audioTrackParamsSchema = z.object({
  trackId: z.string().min(1)
});

const nextSchema = z
  .object({
    forceReplan: z.boolean().optional()
  })
  .optional();

const trackSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  trackKey: z.string().min(1).optional(),
  recordingKey: z.string().min(1).optional(),
  source: z.enum(["ncm", "qq"]).optional(),
  sourceId: z.string().min(1).optional(),
  playbackId: z.string().min(1).optional(),
  lyricsId: z.string().min(1).optional(),
  requiresSubscription: z.boolean().optional(),
  title: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string().optional(),
  durationMs: z.number().optional(),
  coverUrl: z.string().optional(),
  songUrl: z.string().optional(),
  moodTag: z.enum(["calm", "focus", "warm", "night", "energy", "nostalgia", "unknown"]).optional(),
  tags: z.array(z.object({
    category: z.enum(["artist", "mood", "style", "scene", "period", "weather", "routine"]),
    value: z.string().min(1)
  })).optional()
});

const playTrackSchema = z.object({
  track: trackSchema,
  reason: z.string().optional()
});

const queuedTrackParamsSchema = z.object({
  trackId: z.string().min(1)
});

const feedbackSchema = z.object({
  type: z.enum(["skip", "like", "unlike", "replay", "complete", "teach"]),
  trackId: z.union([z.string().min(1), z.number().int()]),
  reason: z.enum([
    "dislike_track",
    "less_this_artist",
    "wrong_for_now",
    "overplayed",
    "bad_version",
    "playback_problem"
  ]).optional(),
  scope: z.enum(["session", "day", "long_term"]).optional(),
  playbackId: z.string().min(1).max(200).optional(),
  decisionId: z.string().min(1).max(200).optional(),
  listenedMs: z.number().finite().nonnegative().optional(),
  durationMs: z.number().finite().nonnegative().optional()
}).superRefine((feedback, context) => {
  // A reason is a teaching correction, not a second interpretation of a
  // positive playback action. Reject contradictory combinations before any
  // favorite/play-count side effect reaches the fact store.
  if (feedback.reason && ["like", "replay", "complete"].includes(feedback.type)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "feedback_reason_conflicts_with_positive_action"
    });
  }
});

const playbackOutcomeSchema = z.object({
  playbackId: z.string().min(1).max(200),
  trackId: z.union([z.string().min(1), z.number().int()]),
  decisionId: z.string().min(1).max(200).optional(),
  outcome: z.enum(["completed", "skipped", "abandoned", "playback_error"]),
  listenedMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative().optional(),
  at: z.string().datetime().optional()
});

const learningUndoSchema = z.object({ undoToken: z.string().min(1).max(500) });

const tasteSignalMutationSchema = z.object({
  action: z.enum(["confirm", "decrease", "block", "delete", "reset_automatic"]),
  signalId: z.string().min(1).max(500).optional()
}).superRefine((value, context) => {
  if (value.action === "reset_automatic" && value.signalId !== undefined) {
    context.addIssue({ code: "custom", message: "reset_automatic_does_not_accept_signal_id" });
  }
  if (value.action !== "reset_automatic" && value.signalId === undefined) {
    context.addIssue({ code: "custom", message: "signal_id_required" });
  }
});

const favoriteParamsSchema = z.object({
  trackId: z.string().min(1)
});

const favoriteSchema = z.object({
  favorite: z.boolean()
});

const environmentLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().optional()
});

const djSettingsSchema = z.object({
  tone: z.enum(["lively", "calm", "professional"]),
  voiceGender: z.enum(["female", "male"]),
  voice: z.string().min(1)
});

type EnvironmentRuntime = Pick<EnvironmentService, "getContext" | "updateLocation">;

interface CreateServerOptions {
  repo?: StateRepository;
  ncm?: NcmConnector;
  wsHub?: WsHub;
  planner?: RadioPlanner;
  tasteEngine?: TasteEngine;
  djBrain?: DjBrain;
  aiDjAssistant?: AiDjAssistant;
  environmentService?: EnvironmentRuntime;
  recommendationImporter?: RecommendationImporter;
  catalog?: MusicCatalog;
  qqMusic?: QqMusicAdapter;
  tasteDocuments?: TasteDocumentManager;
  routineProvider?: RoutineProvider;
  dailyPlanEngine?: DailyPlanEngine;
  tagEnricher?: TrackTagEnricher;
  listeningPolicy?: ListeningPolicy;
  djBroadcastInterval?: number;
  importRetryIntervalMs?: number;
  realtimeApiKey?: string;
  realtimeBaseUrl?: string;
  realtimeWorkspaceId?: string;
  realtimeFetch?: typeof fetch;
  now?: () => Date;
}

export async function createServer(options: CreateServerOptions = {}) {
  const app = Fastify({
    logger: true
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  app.addContentTypeParser("application/sdp", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  const repo = options.repo ?? new StateRepository(config.dbPath);
  const listeningPolicy = options.listeningPolicy ?? new ListeningPolicy({
    ...(options.now ? { now: options.now } : {}),
    state: repo.loadListeningPolicyState(),
    persistence: repo
  });
  const startupNow = options.now?.() ?? new Date();
  repo.pruneIntelligenceHistory(new Date(startupNow.getTime() - 90 * 24 * 60 * 60_000).toISOString());
  const runtimeStateDir = options.repo ? path.dirname(options.repo.dbPath) : config.stateDir;
  const ncm =
    options.ncm ??
    new NcmConnector(config.ncmBaseUrl, () => readCurrentNcmCookie());
  const qqMusic = options.qqMusic ?? new QqMusicAdapter(runtimeStateDir);
  const catalog = options.catalog ?? new MusicCatalog([
    new NcmMusicAdapter(ncm),
    qqMusic
  ]);
  const tasteDocuments = options.tasteDocuments ?? new TasteDocumentManager(runtimeStateDir);
  const routineProvider = options.routineProvider ?? new LocalRoutineProvider(
    options.repo ? path.join(runtimeStateDir, "routine.json") : config.routinePath
  );
  const dailyPlanEngine = options.dailyPlanEngine ?? new DailyPlanEngine(listeningPolicy);
  const aiTagCompleter = createAiTagCompleter({
    ...(config.openAiApiKey ? { apiKey: config.openAiApiKey } : {}),
    ...(config.openAiBaseUrl ? { baseUrl: config.openAiBaseUrl } : {}),
    model: config.openAiModel,
    provider: config.aiProvider
  });
  const tagEnricher = options.tagEnricher ?? new TrackTagEnricher(
    path.join(runtimeStateDir, "track-tag-cache.json"),
    {
      model: config.openAiModel,
      tagVersion: 1,
      ...(aiTagCompleter ? { complete: aiTagCompleter } : {})
    }
  );
  const wsHub = options.wsHub ?? new WsHub();
  const environmentService = options.environmentService ?? new OpenMeteoEnvironmentService();
  const orchestrator = new RadioOrchestrator(
    repo,
    ncm,
    options.tasteEngine ?? new TasteEngine(),
    options.planner ?? new RadioPlanner(Math.random, listeningPolicy),
    options.djBrain ??
      new DjBrain({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiModel,
        provider: config.aiProvider
      }),
    options.aiDjAssistant ??
      new OpenAiDjAssistant({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiModel,
        provider: config.aiProvider,
        chatMaxTokens: config.aiDjChatMaxTokens
      }),
    wsHub,
    options.djBroadcastInterval ?? config.djBroadcastInterval,
    config.aiDjMemoryTurns,
    options.importRetryIntervalMs,
    environmentService,
    options.recommendationImporter ?? new RecommendationImporter(repo, ncm),
    config.realtimeConversationMode,
    catalog,
    tasteDocuments,
    routineProvider,
    dailyPlanEngine,
    tagEnricher,
    "Asia/Shanghai",
    config.intelligencePolicyMode,
    listeningPolicy,
    options.now
  );
  await orchestrator.initialize();
  app.addHook("onClose", async () => {
    await orchestrator.close();
  });

  app.get("/health", async () => ({
    ok: true,
    release: process.env.MUSICGPT_RELEASE?.trim() || "development",
    checkout: process.env.MUSICGPT_CHECKOUT?.trim() || "development",
    runningRoot: process.cwd()
  }));

  app.get("/api/music-sources", async () => orchestrator.getMusicSources());

  app.post("/api/music-sources/qq/auth/qr", async (_request, reply) => {
    try {
      return await qqMusic.createQr();
    } catch (error) {
      return reply.status(502).send({
        error: "qq_qr_create_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/music-sources/qq/auth/qr/:sessionId", async (request, reply) => {
    const parsed = z.object({ sessionId: z.string().min(1).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_qq_qr_session" });
    const status = await qqMusic.pollQr(parsed.data.sessionId);
    if (status.status === "authorized") {
      await orchestrator.syncMusicSource("qq").catch((error) => {
        request.log.warn({ err: error }, "QQ Music initial sync failed after authorization");
      });
    }
    return status;
  });

  app.delete("/api/music-sources/qq/auth", async () => {
    qqMusic.disconnect();
    return { ok: true, status: await qqMusic.status() };
  });

  app.post("/api/music-sources/:source/sync", async (request, reply) => {
    const parsed = z.object({ source: z.enum(["ncm", "qq"]) }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_music_source" });
    try {
      return await orchestrator.syncMusicSource(parsed.data.source as MusicSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not_connected") ? 401 : 502;
      return reply.status(status).send({ error: "music_source_sync_failed", message });
    }
  });

  app.get("/api/library/export", async () => orchestrator.getLibraryExport());

  app.get("/api/daily-plan", async () => orchestrator.getDailyPlan(false));

  app.post("/api/daily-plan/regenerate", async () => orchestrator.getDailyPlan(true));

  app.post("/api/daily-plan/play", async (_request, reply) => {
    orchestrator.touchListeningInteraction();
    const result = await orchestrator.playCurrentDailyPlanSegment();
    if (!result) return reply.status(409).send({ error: "daily_plan_segment_empty" });
    return result;
  });

  app.get("/api/realtime/session", async (request, reply) => {
    const parsed = realtimeSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
    const context = orchestrator.buildRealtimeContext(sessionId, parsed.data.baselineRevision);
    return {
      enabled: isRealtimeSessionConfigured(
        options.realtimeApiKey ?? config.dashScopeRealtimeApiKey,
        options.realtimeBaseUrl ?? config.dashScopeRealtimeBaseUrl,
        options.realtimeWorkspaceId ?? config.dashScopeWorkspaceId
      ),
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      sessionId,
      contextRevision: context.contextRevision,
      conversationMode: config.realtimeConversationMode,
      session: buildRealtimeSessionConfig(
        config.realtimeConversationMode === "unified" ? context.instructions : undefined,
        config.realtimeConversationMode
      )
    };
  });

  app.get("/api/realtime/context", async (request, reply) => {
    const parsed = realtimeSessionQuerySchema.safeParse(request.query);
    if (!parsed.success || !parsed.data.sessionId) {
      return reply.status(400).send({ error: "invalid_realtime_context_query" });
    }
    const context = orchestrator.buildRealtimeContext(
      parsed.data.sessionId,
      parsed.data.baselineRevision
    );
    return {
      sessionId: parsed.data.sessionId,
      ...context,
      session: buildRealtimeSessionConfig(
        config.realtimeConversationMode === "unified" ? context.instructions : undefined,
        config.realtimeConversationMode
      )
    };
  });

  app.post("/api/realtime/errors", async (request, reply) => {
    const parsed = realtimeErrorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_realtime_error" });
    }
    await orchestrator.reportRealtimeError(parsed.data.code);
    return { ok: true };
  });

  app.post("/api/realtime/session", async (request, reply) => {
    const apiKey = options.realtimeApiKey ?? config.dashScopeRealtimeApiKey;
    if (!apiKey) {
      return reply.status(503).send({ error: "dashscope_realtime_not_configured" });
    }
    const realtimeBaseUrl = options.realtimeBaseUrl ?? config.dashScopeRealtimeBaseUrl;
    const realtimeWorkspaceId = options.realtimeWorkspaceId ?? config.dashScopeWorkspaceId;
    if (!realtimeBaseUrl && !realtimeWorkspaceId) {
      return reply.status(503).send({ error: "dashscope_realtime_endpoint_not_configured" });
    }
    if (typeof request.body !== "string" || request.body.trim().length === 0) {
      return reply.status(400).send({ error: "invalid_sdp_offer" });
    }

    try {
      const answerSdp = await createRealtimeSession({
        apiKey,
        ...(realtimeBaseUrl ? { baseUrl: realtimeBaseUrl } : {}),
        ...(realtimeWorkspaceId ? { workspaceId: realtimeWorkspaceId } : {}),
        offerSdp: request.body,
        ...(options.realtimeFetch ? { fetchFn: options.realtimeFetch } : {})
      });
      return reply.status(201).type("application/sdp").send(answerSdp);
    } catch (error) {
      request.log.error({ err: error }, "DashScope Realtime session setup failed");
      return reply.status(502).send({ error: "realtime_session_failed" });
    }
  });

  app.get("/api/now", async () => orchestrator.getNow());

  app.get("/api/tracks/:trackId/audio", async (request, reply) => {
    const parsed = audioTrackParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    reply.header("cache-control", "no-store");
    const trackKey = normalizeTrackReference(parsed.data.trackId);
    const track = repo.getTrackStats(5000).find((stat) => stat.track.trackKey === trackKey)?.track;
    const resolved = track ? await catalog.resolvePlayback(track) : undefined;
    const songUrl = resolved?.url ??
      (trackKey.startsWith("ncm:")
        ? await ncm.resolveSongUrl(Number(sourceIdFromKey(trackKey)))
        : undefined);
    if (!songUrl) {
      return reply.status(503).send({ error: "audio_unavailable" });
    }
    return reply.redirect(songUrl);
  });

  app.get("/api/taste", async () => {
    const taste = orchestrator.getTasteWithDocument();
    if (!taste) {
      return null;
    }
    return taste;
  });

  app.post("/api/next", async (request, reply) => {
    const parsed = nextSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    orchestrator.touchListeningInteraction();
    const now = await orchestrator.nextTrack(parsed.data?.forceReplan ?? false);
    return { now };
  });

  app.post("/api/play-track", async (request, reply) => {
    const parsed = playTrackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    orchestrator.touchListeningInteraction();
    const now = await orchestrator.playSuggestedTrack(parsed.data.track as Track, parsed.data.reason);
    return { now };
  });

  app.post("/api/queue/:trackId/play", async (request, reply) => {
    const parsed = queuedTrackParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    let now;
    try {
      orchestrator.touchListeningInteraction();
      now = await orchestrator.playQueuedTrack(parsed.data.trackId);
    } catch (error) {
      if (error instanceof QueuedTrackPlaybackError) {
        return reply.status(503).send({ error: error.code });
      }
      throw error;
    }
    if (!now) {
      return reply.status(404).send({ error: "queued_track_not_found" });
    }
    return { now };
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.handleChat(parsed.data.message, parsed.data.turnId);
  });

  app.post("/api/chat/stream", async (request, reply) => {
    const parsed = chatStreamSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    });
    reply.raw.flushHeaders();
    const writeEvent = (event: unknown) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`${JSON.stringify(event)}\n`);
      }
    };

    try {
      await orchestrator.handleChatStream(parsed.data.message, {
        onTextDelta: (delta) => writeEvent({ type: "text_delta", delta }),
        onResult: (response) => writeEvent({ type: "result", response })
      }, parsed.data.turnId);
    } catch {
      writeEvent({ type: "error", message: "chat_stream_failed" });
    } finally {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
    return reply;
  });

  app.get("/api/chat/history", async () => orchestrator.getChatHistory());

  app.post("/api/conversation/voice/turns", async (request, reply) => {
    const parsed = voiceTurnSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.startVoiceTurn(parsed.data);
  });

  app.post("/api/conversation/voice/turns/:turnId/complete", async (request, reply) => {
    const params = voiceTurnParamsSchema.safeParse(request.params);
    const body = voiceTurnCompleteSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "invalid_voice_turn_completion" });
    }
    try {
      return {
        messages: await orchestrator.completeVoiceTurn(params.data.turnId, {
          model: body.data.model,
          status: body.data.status,
          at: body.data.at,
          ...(body.data.transcript !== undefined ? { transcript: body.data.transcript } : {}),
          ...(body.data.responseId !== undefined ? { responseId: body.data.responseId } : {})
        })
      };
    } catch (error) {
      if (error instanceof Error && error.message === "voice_turn_not_found") {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/music/commands", async (request, reply) => {
    const parsed = musicCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.executeMusicCommand({
      turnId: parsed.data.turnId,
      commandId: parsed.data.commandId,
      request: parsed.data.request,
      mode: parsed.data.mode,
      ...(parsed.data.confirmationToken !== undefined
        ? { confirmationToken: parsed.data.confirmationToken }
        : {}),
      ...(parsed.data.selectedTrackId !== undefined
        ? { selectedTrackId: parsed.data.selectedTrackId }
        : {})
    });
  });

  app.get("/api/chat/memories", async () => orchestrator.getChatMemories());

  app.delete("/api/chat/memories/:memoryId", async (request, reply) => {
    const parsed = chatMemoryParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!orchestrator.deleteChatMemory(parsed.data.memoryId)) {
      return reply.status(404).send({ error: "chat_memory_not_found" });
    }
    return { ok: true };
  });

  app.delete("/api/chat/memories", async () => orchestrator.clearChatMemories());

  app.delete("/api/chat/history", async () => orchestrator.clearChatHistory());

  app.post("/api/feedback", async (request, reply) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const learningReceipt = await orchestrator.handleFeedback(parsed.data as FeedbackRequest);
    return { ok: true, learningReceipt };
  });

  app.post("/api/listening/outcomes", async (request, reply) => {
    const parsed = playbackOutcomeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const result = await orchestrator.handlePlaybackOutcome(parsed.data as PlaybackOutcomeRequest);
    return { ok: true, ...result };
  });

  app.post("/api/learning/undo", async (request, reply) => {
    const parsed = learningUndoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const learningReceipt = await orchestrator.undoLearning(parsed.data.undoToken);
    if (!learningReceipt) {
      return reply.status(404).send({ error: "learning_receipt_not_found_or_expired" });
    }
    return { ok: true, learningReceipt };
  });

  app.post("/api/taste/signals", async (request, reply) => {
    const parsed = tasteSignalMutationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const learningReceipt = await orchestrator.mutateTasteSignal(parsed.data as TasteSignalMutationRequest);
    if (!learningReceipt) {
      return reply.status(404).send({ error: "taste_signal_not_found_or_locked" });
    }
    return { ok: true, learningReceipt };
  });

  app.put("/api/favorites/:trackId", async (request, reply) => {
    const params = favoriteParamsSchema.safeParse(request.params);
    const body = favoriteSchema.safeParse(request.body);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }
    return orchestrator.setFavorite(params.data.trackId, body.data.favorite);
  });

  app.get("/api/system/status", async () => orchestrator.getSystemStatus());

  app.get("/api/environment", async () => orchestrator.getEnvironment());

  app.post("/api/environment/location", async (request, reply) => {
    const parsed = environmentLocationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const location = {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      ...(parsed.data.label ? { label: parsed.data.label } : {})
    };
    return orchestrator.updateEnvironmentLocation(location);
  });

  app.post("/api/recommendations/import", async () => orchestrator.importRecommendations());

  app.get("/api/dj/settings", async () => orchestrator.getDjSettings());

  app.post("/api/dj/settings", async (request, reply) => {
    const parsed = djSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.updateDjSettings(parsed.data);
  });

  app.post("/api/import/ncm", async (_request, reply) => {
    const result = await orchestrator.importFromNcmAndRefresh();
    if (!result.ok) {
      return reply.status(503).send(result);
    }
    return result;
  });

  app.get("/api/providers", async () => ({
    weather: { enabled: false },
    calendar: { enabled: false },
    upnp: { enabled: false }
  }));

  app.get("/ws/stream", { websocket: true }, (socket) => {
    wsHub.addSocket(socket);
    socket.send(JSON.stringify({ event: "queue_updated", data: orchestrator.getNow().queue }));
    socket.on("close", () => wsHub.removeSocket(socket));
  });

  return app;
}
