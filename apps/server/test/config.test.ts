import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("config", () => {
  it("treats an empty OPENAI_BASE_URL as unset", async () => {
    process.env.MUSICGPT_SKIP_DOTENV = "true";
    process.env.OPENAI_BASE_URL = "";

    const { config } = await import("../src/config.js");

    expect(config.openAiBaseUrl).toBeUndefined();
  });

  it("lets the project .env override inherited process environment variables", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-config-"));
    fs.writeFileSync(
      path.join(tmp, ".env"),
      [
        "OPENAI_API_KEY=new-project-key",
        "OPENAI_BASE_URL=https://api.deepseek.com",
        "OPENAI_MODEL=deepseek-v4-flash"
      ].join("\n")
    );
    process.chdir(tmp);
    process.env.MUSICGPT_SKIP_DOTENV = "false";
    process.env.OPENAI_API_KEY = "old-inherited-key";
    process.env.OPENAI_BASE_URL = "https://old.example.com";
    process.env.OPENAI_MODEL = "old-model";

    const { config } = await import("../src/config.js");

    expect(config.openAiApiKey).toBe("new-project-key");
    expect(config.openAiBaseUrl).toBe("https://api.deepseek.com");
    expect(config.openAiModel).toBe("deepseek-v4-flash");
  });
});
