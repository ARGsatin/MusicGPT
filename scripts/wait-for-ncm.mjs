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

const baseUrl = String(
  process.env.NCM_BASE_URL || "http://127.0.0.1:3001"
).replace(/\/+$/, "");
const once = process.argv.includes("--once");
const waitTimeoutMs = 60_000;
const deadline = Date.now() + waitTimeoutMs;

while (true) {
  try {
    const response = await fetch(`${baseUrl}/inner/version`, {
      signal: AbortSignal.timeout(3_000)
    });
    if (response.ok) {
      console.log(`NCM API readiness check passed: ${baseUrl}`);
      process.exit(0);
    }
  } catch {
    // The supervisor may still be starting the local API.
  }
  if (once || Date.now() >= deadline) {
    break;
  }
  await sleep(1_000);
}

if (!once) {
  console.error(`NCM API was not ready within 60 seconds: ${baseUrl}`);
}
process.exit(1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
