import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

if ((await run("wait-for-ncm.mjs")) !== 0) {
  process.exit(1);
}
if ((await run("ensure-ncm-login.mjs")) !== 0) {
  process.exit(1);
}

openUrl("http://127.0.0.1:5173");

function run(filename) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scriptDir, filename)], {
      cwd: projectRoot,
      stdio: "inherit"
    });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function openUrl(url) {
  const command =
    process.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/c", "start", "", url] }
      : process.platform === "darwin"
        ? { executable: "open", args: [url] }
        : { executable: "xdg-open", args: [url] };
  const opener = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore"
  });
  opener.once("error", () => undefined);
  opener.unref();
}
