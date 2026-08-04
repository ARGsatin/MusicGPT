import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

let loadedEnvPath: string | undefined;

function loadEnvFiles(): void {
  if (process.env.MUSICGPT_SKIP_DOTENV === "true") {
    return;
  }

  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../../.env")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: true });
      loadedEnvPath = candidate;
    }
  }
}

loadEnvFiles();

const optionalString = () => z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalUrl = () => z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional());

const schema = z.object({
  OPENAI_API_KEY: optionalString(),
  OPENAI_BASE_URL: optionalUrl(),
  OPENAI_MODEL: optionalString(),
  DASHSCOPE_API_KEY: optionalString(),
  DASHSCOPE_WORKSPACE_ID: optionalString(),
  DASHSCOPE_REALTIME_BASE_URL: optionalUrl(),
  DEEPSEEK_API_KEY: optionalString(),
  DEEPSEEK_BASE_URL: optionalUrl(),
  DEEPSEEK_MODEL: optionalString(),
  AI_DJ_MEMORY_TURNS: z.coerce.number().int().min(1).max(30).default(20),
  AI_DJ_CHAT_MAX_TOKENS: z.coerce.number().int().min(200).max(2_000).default(800),
  NCM_COOKIE: optionalString(),
  NCM_BASE_URL: z.string().url().default("http://127.0.0.1:3001"),
  DB_PATH: z.string().default("./state/musicgpt.db"),
  DJ_BROADCAST_INTERVAL: z.coerce.number().int().min(1).max(10).default(4),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787)
});

const parsed = schema.parse(process.env);

export type AiProvider = "openai" | "deepseek" | "local";

function resolveAiProvider(values: z.infer<typeof schema>): {
  provider: AiProvider;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
} {
  if (values.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: values.OPENAI_API_KEY,
      baseUrl: values.OPENAI_BASE_URL,
      model: values.OPENAI_MODEL ?? "gpt-4.1-mini"
    };
  }

  if (values.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      apiKey: values.DEEPSEEK_API_KEY,
      baseUrl: values.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      model: values.DEEPSEEK_MODEL ?? "deepseek-v4-flash"
    };
  }

  return {
    provider: "local",
    apiKey: undefined,
    baseUrl: undefined,
    model: values.OPENAI_MODEL ?? values.DEEPSEEK_MODEL ?? "gpt-4.1-mini"
  };
}

const aiProvider = resolveAiProvider(parsed);

const resolvedDbPath = path.isAbsolute(parsed.DB_PATH)
  ? parsed.DB_PATH
  : path.resolve(process.cwd(), parsed.DB_PATH);

export const config = {
  aiProvider: aiProvider.provider,
  openAiApiKey: aiProvider.apiKey,
  openAiBaseUrl: aiProvider.baseUrl,
  openAiModel: aiProvider.model,
  dashScopeRealtimeApiKey: parsed.DASHSCOPE_API_KEY,
  dashScopeWorkspaceId: parsed.DASHSCOPE_WORKSPACE_ID,
  dashScopeRealtimeBaseUrl: parsed.DASHSCOPE_REALTIME_BASE_URL,
  aiDjMemoryTurns: parsed.AI_DJ_MEMORY_TURNS,
  aiDjChatMaxTokens: parsed.AI_DJ_CHAT_MAX_TOKENS,
  ncmCookie: parsed.NCM_COOKIE,
  ncmBaseUrl: parsed.NCM_BASE_URL,
  dbPath: resolvedDbPath,
  djBroadcastInterval: parsed.DJ_BROADCAST_INTERVAL,
  serverPort: parsed.SERVER_PORT
};

export function readCurrentNcmCookie(): string | undefined {
  if (!loadedEnvPath || !fs.existsSync(loadedEnvPath)) {
    return process.env.NCM_COOKIE?.trim() || undefined;
  }

  const values = dotenv.parse(fs.readFileSync(loadedEnvPath, "utf8"));
  return values.NCM_COOKIE?.trim() || undefined;
}
