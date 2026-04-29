import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
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
});
