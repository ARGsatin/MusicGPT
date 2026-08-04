import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run deepseek:check");
  console.log("");
  console.log("Checks the configured DeepSeek key, model, and non-thinking Chat Completions request.");
  process.exit(0);
}

dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false });

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";

if (!apiKey) {
  console.error("DeepSeek check failed: DEEPSEEK_API_KEY is not configured.");
  process.exitCode = 1;
} else {
  try {
    await requestJson(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    const completion = await requestJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 16,
        thinking: { type: "disabled" }
      })
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("the API returned an empty completion");
    }

    console.log(`DeepSeek check passed: ${baseUrl}, model=${model}, reply=${reply}`);
  } catch (error) {
    console.error(`DeepSeek check failed: ${summarize(error)}`);
    process.exitCode = 1;
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 400)}` : ""}`);
  }
  return text ? JSON.parse(text) : {};
}

function summarize(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (!cause) {
    return message.replace(/\s+/g, " ").slice(0, 500);
  }
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const causeCode = typeof cause === "object" && cause && "code" in cause ? String(cause.code) : "";
  return `${message} | cause=${[causeCode, causeMessage].filter(Boolean).join(" ")}`
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
