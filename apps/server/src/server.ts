import fs from "node:fs";
import path from "node:path";

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
import { RecommendationImporter } from "./recommendationImporter.js";
import { StateRepository } from "./stateRepository.js";
import { TasteEngine } from "./tasteEngine.js";
import { TtsPipeline } from "./ttsPipeline.js";
import { WsHub } from "./wsHub.js";

const chatSchema = z.object({
  message: z.string().min(1)
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
  moodTag: z.enum(["calm", "focus", "warm", "night", "energy", "nostalgia", "unknown"]).optional()
});

const playTrackSchema = z.object({
  track: trackSchema,
  reason: z.string().optional()
});

const feedbackSchema = z.object({
  type: z.enum(["skip", "like", "replay", "complete"]),
  trackId: z.number().int()
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
  ttsPipeline?: TtsPipeline;
  environmentService?: EnvironmentRuntime;
  recommendationImporter?: RecommendationImporter;
  djBroadcastInterval?: number;
  importRetryIntervalMs?: number;
}

export async function createServer(options: CreateServerOptions = {}) {
  const app = Fastify({
    logger: true
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  fs.mkdirSync(config.ttsCacheDir, { recursive: true });

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
    options.djBrain ?? new DjBrain(config.openAiApiKey),
    options.aiDjAssistant ??
      new OpenAiDjAssistant({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiModel,
        provider: config.aiProvider
      }),
    options.ttsPipeline ?? new TtsPipeline(config.ttsCacheDir, config.ttsVoice),
    wsHub,
    options.djBroadcastInterval ?? config.djBroadcastInterval,
    config.aiDjMemoryTurns,
    options.importRetryIntervalMs,
    environmentService,
    options.recommendationImporter ?? new RecommendationImporter(repo, ncm)
  );
  await orchestrator.initialize();
  app.addHook("onClose", async () => {
    orchestrator.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/now", async () => orchestrator.getNow());

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

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.handleChat(parsed.data.message);
  });

  app.get("/api/chat/history", async () => orchestrator.getChatHistory());

  app.delete("/api/chat/history", async () => orchestrator.clearChatHistory());

  app.post("/api/feedback", async (request, reply) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    await orchestrator.handleFeedback(parsed.data);
    return { ok: true };
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

  app.get("/tts-cache/:file", async (request, reply) => {
    const filename = path.basename((request.params as { file: string }).file);
    const filePath = path.resolve(config.ttsCacheDir, filename);
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: "not_found" });
    }
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(filePath));
  });

  app.get("/ws/stream", { websocket: true }, (socket) => {
    wsHub.addSocket(socket);
    socket.send(JSON.stringify({ event: "queue_updated", data: orchestrator.getNow().queue }));
    socket.on("close", () => wsHub.removeSocket(socket));
  });

  return app;
}
