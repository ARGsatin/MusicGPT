import { spawn } from "node:child_process";
import net from "node:net";

const port = process.env.NCM_PORT || "3001";
const baseUrl = process.env.NCM_BASE_URL || `http://127.0.0.1:${port}`;

if (await isNcmApiReachable(baseUrl)) {
  console.log(`NCM API already running at ${baseUrl}. Reusing existing process.`);
  process.exit(0);
}

if (await isPortInUse(Number(port))) {
  console.error(`Port ${port} is already in use, but ${baseUrl} is not a healthy NCM API.`);
  console.error("Please stop the conflicting process or set NCM_PORT to a different port.");
  process.exit(1);
}

const child = spawn("npx", ["-y", "NeteaseCloudMusicApi@latest"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    PORT: port
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

async function isNcmApiReachable(url) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/login/status?timestamp=${Date.now()}`, {
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortInUse(targetPort) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", (error) => {
        if (error?.code === "EADDRINUSE") {
          resolve(true);
          return;
        }
        resolve(true);
      })
      .once("listening", () => {
        tester.close(() => resolve(false));
      })
      .listen(targetPort, "0.0.0.0");
  });
}
