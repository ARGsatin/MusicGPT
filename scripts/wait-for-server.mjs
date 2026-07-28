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

const port = Number(process.env.SERVER_PORT || 8787);
const healthUrl = `http://127.0.0.1:${port}/health`;
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3_000)
    });
    if (response.ok) {
      console.log(`MusicGPT server readiness check passed: ${healthUrl}`);
      process.exit(0);
    }
  } catch {
    // The server may still be starting.
  }
  await sleep(1_000);
}

console.error(`MusicGPT server was not ready within 60 seconds: ${healthUrl}`);
process.exit(1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
