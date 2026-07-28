import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const configuredUrl = new URL(
  process.env.NCM_BASE_URL || "http://127.0.0.1:3001"
);
const port = Number(process.env.NCM_PORT || configuredUrl.port || 3001);
configuredUrl.port = String(port);
const baseUrl = configuredUrl.toString().replace(/\/+$/, "");
const ncmPackageEntry = path.join(
  projectRoot,
  "node_modules",
  "NeteaseCloudMusicApi",
  "server.js"
);
const ncmServiceEntry = path.join(scriptDir, "ncm-service.cjs");
const monitorIntervalMs = 3_000;
const startupTimeoutMs = 45_000;

let child;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log("Stopping the NCM API supervisor...");
    if (child && child.exitCode === null) {
      child.kill();
    }
    setTimeout(() => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
      process.exit(0);
    }, 2_000);
  });
}

await supervise();

async function supervise() {
  if (!fs.existsSync(ncmPackageEntry)) {
    console.error(`Pinned NCM API is not installed: ${ncmPackageEntry}`);
    console.error("Run npm install, then start MusicGPT again.");
    process.exitCode = 1;
    return;
  }

  if (await isNcmApiReachable()) {
    console.log(`NCM API is healthy at ${baseUrl}. Monitoring it for failures.`);
  }

  let consecutiveUnhealthyChecks = 0;
  while (!stopping) {
    if (await isNcmApiReachable()) {
      consecutiveUnhealthyChecks = 0;
      await sleep(monitorIntervalMs);
      continue;
    }

    consecutiveUnhealthyChecks += 1;
    if (child && child.exitCode === null && consecutiveUnhealthyChecks < 3) {
      await sleep(monitorIntervalMs);
      continue;
    }

    if (child && child.exitCode === null) {
      console.warn("Managed NCM API became unhealthy. Restarting it.");
      child.kill();
      await waitForChildExit(child, 5_000);
    }
    child = undefined;

    if (await isPortInUse(port)) {
      console.error(
        `Port ${port} is occupied, but ${baseUrl} is not a healthy NCM API.`
      );
      console.error("Stop the conflicting process and start MusicGPT again.");
      process.exitCode = 1;
      return;
    }

    console.log(`Starting pinned NCM API 4.32.0 at ${baseUrl}...`);
    child = spawn(process.execPath, [ncmServiceEntry], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: String(port)
      }
    });
    child.once("error", (error) => {
      console.error(`Failed to start NCM API: ${error.message}`);
    });

    const ready = await waitForHealthyOrExit(child, startupTimeoutMs);
    if (ready) {
      console.log(`NCM API is ready at ${baseUrl}.`);
      consecutiveUnhealthyChecks = 0;
      continue;
    }

    if (child.exitCode === null) {
      child.kill();
    }
    console.error("NCM API did not become healthy. Retrying in 3 seconds.");
    await sleep(monitorIntervalMs);
  }
}

async function waitForHealthyOrExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    if (await isNcmApiReachable()) {
      return true;
    }
    if (target.exitCode !== null) {
      return false;
    }
    await sleep(1_000);
  }
  return false;
}

async function isNcmApiReachable() {
  try {
    const response = await fetch(`${baseUrl}/inner/version`, {
      signal: AbortSignal.timeout(3_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortInUse(targetPort) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(true))
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(targetPort, "0.0.0.0");
  });
}

function waitForChildExit(target, timeoutMs) {
  if (target.exitCode !== null) {
    return Promise.resolve();
  }
  return Promise.race([
    new Promise((resolve) => target.once("exit", resolve)),
    sleep(timeoutMs)
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
