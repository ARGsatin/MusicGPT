import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";

import { config, readCurrentNcmCookie } from "./config.js";
import type { Track } from "@musicgpt/shared";
import type { AiDjAssistant } from "./aiDjAssistant.js";
import { OpenAiDjAssistant } from "./aiDjAssistant.js";
import { DjBrain } from "./djBrain.js";
import type { EnvironmentService } from "./environmentService.js";
import { EnvironmentService as OpenMeteoEnvironmentService } from "./environmentService.js";
import { NcmConnector } from "./ncmConnector.js";
import { RadioOrchestrator } from "./orchestrator.js";
import { RadioPlanner } from "./radioPlanner.js";
import {
  buildRealtimeSessionConfig,
  createRealtimeSession,
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
  selectedTrackId: z.number().int().optional()
});

const audioTrackParamsSchema = z.object({
  trackId: z.coerce.number().int().positive()
});

const nextSchema = z
  .object({
    forceReplan: z.boolean().optional()
  })
  .optional();

const trackSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  artists: z.array(z.string()),
  album: z.string().optional(),
  durationMs: z.number().optional(),
  coverUrl: z.string().optional(),
  songUrl: z.string().optional(),
  moodTag: z.enum(["calm", "focus", "warm", "night", "energy", "nostalgia", "unknown"]).optional(),
  tags: z.array(z.object({
    category: z.enum(["artist", "mood", "style", "scene", "period", "weather"]),
    value: z.string().min(1)
  })).optional()
});

const playTrackSchema = z.object({
  track: trackSchema,
  reason: z.string().optional()
});

const queuedTrackParamsSchema = z.object({
  trackId: z.coerce.number().int().positive()
});

const feedbackSchema = z.object({
  type: z.enum(["skip", "like", "unlike", "replay", "complete"]),
  trackId: z.number().int()
});

const favoriteParamsSchema = z.object({
  trackId: z.coerce.number().int()
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
  djBroadcastInterval?: number;
  importRetryIntervalMs?: number;
  realtimeApiKey?: string;
  realtimeBaseUrl?: string;
  realtimeWorkspaceId?: string;
  realtimeFetch?: typeof fetch;
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
  const ncm =
    options.ncm ??
    new NcmConnector(config.ncmBaseUrl, () => readCurrentNcmCookie());
  const wsHub = options.wsHub ?? new WsHub();
  const environmentService = options.environmentService ?? new OpenMeteoEnvironmentService();
  const orchestrator = new RadioOrchestrator(
    repo,
    ncm,
    options.tasteEngine ?? new TasteEngine(),
    options.planner ?? new RadioPlanner(),
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
    config.realtimeConversationMode
  );
  await orchestrator.initialize();
  app.addHook("onClose", async () => {
    await orchestrator.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/realtime/session", async (request, reply) => {
    const parsed = realtimeSessionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const sessionId = parsed.data.sessionId ?? crypto.randomUUID();
    const context = orchestrator.buildRealtimeContext(sessionId, parsed.data.baselineRevision);
    return {
      enabled: Boolean(options.realtimeApiKey ?? config.dashScopeRealtimeApiKey),
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
    if (typeof request.body !== "string" || request.body.trim().length === 0) {
      return reply.status(400).send({ error: "invalid_sdp_offer" });
    }

    try {
      const realtimeBaseUrl = options.realtimeBaseUrl ?? config.dashScopeRealtimeBaseUrl;
      const realtimeWorkspaceId = options.realtimeWorkspaceId ?? config.dashScopeWorkspaceId;
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
    const songUrl = await ncm.resolveSongUrl(parsed.data.trackId);
    if (!songUrl) {
      return reply.status(503).send({ error: "audio_unavailable" });
    }
    return reply.redirect(songUrl);
  });

  app.get("/api/taste", async () => {
    const taste = orchestrator.getTaste();
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
    const now = await orchestrator.nextTrack(parsed.data?.forceReplan ?? false);
    return { now };
  });

  app.post("/api/play-track", async (request, reply) => {
    const parsed = playTrackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const now = await orchestrator.playSuggestedTrack(parsed.data.track as Track, parsed.data.reason);
    return { now };
  });

  app.post("/api/queue/:trackId/play", async (request, reply) => {
    const parsed = queuedTrackParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const now = await orchestrator.playQueuedTrack(parsed.data.trackId);
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
    await orchestrator.handleFeedback(parsed.data);
    return { ok: true };
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
