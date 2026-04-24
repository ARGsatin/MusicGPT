import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

function loadEnvFiles(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../../.env")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false });
    }
  }
}

loadEnvFiles();

const schema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  NCM_COOKIE: z.string().optional(),
  NCM_BASE_URL: z.string().url().default("http://127.0.0.1:3001"),
  TTS_VOICE: z.string().default("zh-CN-XiaoxiaoNeural"),
  DB_PATH: z.string().default("./state/musicgpt.db"),
  DJ_BROADCAST_INTERVAL: z.coerce.number().int().min(1).max(10).default(4),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787)
});

const parsed = schema.parse(process.env);

const resolvedDbPath = path.isAbsolute(parsed.DB_PATH)
  ? parsed.DB_PATH
  : path.resolve(process.cwd(), parsed.DB_PATH);

const resolvedTtsDir = path.resolve(path.dirname(resolvedDbPath), "../tts-cache");

export const config = {
  openAiApiKey: parsed.OPENAI_API_KEY,
  ncmCookie: parsed.NCM_COOKIE,
  ncmBaseUrl: parsed.NCM_BASE_URL,
  ttsVoice: parsed.TTS_VOICE,
  dbPath: resolvedDbPath,
  ttsCacheDir: resolvedTtsDir,
  djBroadcastInterval: parsed.DJ_BROADCAST_INTERVAL,
  serverPort: parsed.SERVER_PORT
};
