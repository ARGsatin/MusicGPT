import { spawn } from "node:child_process";

const port = process.env.NCM_PORT || "3001";

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

