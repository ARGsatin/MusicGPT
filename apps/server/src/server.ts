import fs from "node:fs";
import path from "node:path";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";

import { config } from "./config.js";
import { DjBrain } from "./djBrain.js";
import { NcmConnector } from "./ncmConnector.js";
import { RadioOrchestrator } from "./orchestrator.js";
import { RadioPlanner } from "./radioPlanner.js";
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

const feedbackSchema = z.object({
  type: z.enum(["skip", "like", "replay", "complete"]),
  trackId: z.number().int()
});

interface CreateServerOptions {
  repo?: StateRepository;
  ncm?: NcmConnector;
  wsHub?: WsHub;
  planner?: RadioPlanner;
  tasteEngine?: TasteEngine;
  djBrain?: DjBrain;
  ttsPipeline?: TtsPipeline;
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
  const ncm = options.ncm ?? new NcmConnector(config.ncmBaseUrl, config.ncmCookie);
  const wsHub = options.wsHub ?? new WsHub();
  const orchestrator = new RadioOrchestrator(
    repo,
    ncm,
    options.tasteEngine ?? new TasteEngine(),
    options.planner ?? new RadioPlanner(),
    options.djBrain ?? new DjBrain(config.openAiApiKey),
    options.ttsPipeline ?? new TtsPipeline(config.ttsCacheDir, config.ttsVoice),
    wsHub,
    options.djBroadcastInterval ?? config.djBroadcastInterval,
    options.importRetryIntervalMs
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

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    return orchestrator.handleChat(parsed.data.message);
  });

  app.post("/api/feedback", async (request, reply) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    await orchestrator.handleFeedback(parsed.data);
    return { ok: true };
  });

  app.get("/api/system/status", async () => orchestrator.getSystemStatus());

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
    socket.on("close", () => wsHub.removeSocket(socket));
  });

  return app;
}
