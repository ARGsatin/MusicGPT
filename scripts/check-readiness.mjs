import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const ncmBaseUrl = String(process.env.NCM_BASE_URL || "http://127.0.0.1:3001").replace(/\/+$/u, "");
const serverPort = Number(process.env.SERVER_PORT || 8787);
const webPort = Number(process.env.MUSICGPT_WEB_PORT || 5173);
const expectedRelease = process.env.MUSICGPT_EXPECT_RELEASE?.trim();
const once = process.argv.includes("--once");
const deadline = Date.now() + (once ? 0 : 60_000);

do {
  const result = await checkStack();
  if (result.ok) {
    console.log(`MusicGPT readiness check passed: API ${result.release}, web and NCM are healthy.`);
    process.exit(0);
  }
  if (once || Date.now() >= deadline) {
    console.error(`MusicGPT readiness check failed: ${result.reason}`);
    process.exit(1);
  }
  await sleep(1_000);
} while (true);

async function checkStack() {
  try {
    const ncmResponse = await fetch(`${ncmBaseUrl}/inner/version`, { signal: AbortSignal.timeout(3_000) });
    if (!ncmResponse.ok) {
      return { ok: false, reason: `NCM returned HTTP ${ncmResponse.status}` };
    }

    const healthUrl = `http://127.0.0.1:${serverPort}/health`;
    const apiResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
    if (!apiResponse.ok) {
      return { ok: false, reason: `API returned HTTP ${apiResponse.status}` };
    }
    const health = await apiResponse.json();
    if (health?.ok !== true) {
      return { ok: false, reason: "API health payload did not report ok=true" };
    }
    if (expectedRelease && health.release !== expectedRelease) {
      return { ok: false, reason: `API is release ${health.release || "unknown"}, expected ${expectedRelease}` };
    }

    const webResponse = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(3_000) });
    if (!webResponse.ok) {
      return { ok: false, reason: `web returned HTTP ${webResponse.status}` };
    }
    const html = await webResponse.text();
    if (!html.includes('id="root"')) {
      return { ok: false, reason: "web response was not the MusicGPT application shell" };
    }
    return { ok: true, release: health.release || "development" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
