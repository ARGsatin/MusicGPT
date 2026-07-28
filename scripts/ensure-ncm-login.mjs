import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const authenticationFailureCodes = new Set([2, 4]);
let checkCode = 1;

for (let attempt = 1; attempt <= 3; attempt += 1) {
  checkCode = await runNodeScript("check-ncm-cookie.mjs");
  if (checkCode === 0) {
    process.exit(0);
  }
  if (authenticationFailureCodes.has(checkCode)) {
    break;
  }
  if (attempt < 3) {
    console.warn(`NCM dependency check failed (${attempt}/3); retrying without replacing the Cookie...`);
    await sleep(2_000);
  }
}

if (!authenticationFailureCodes.has(checkCode)) {
  console.error("");
  console.error("NCM API is temporarily unhealthy. Keeping the existing Cookie unchanged.");
  console.error("The supervisor will keep the API running; try the import again shortly.");
  process.exit(checkCode);
}

console.warn("");
console.warn("NCM login is missing or expired. Starting QR login recovery...");
console.warn("");

const setupCode = await runNodeScript("setup-ncm-cookie.mjs");
if (setupCode !== 0) {
  console.error("NCM QR login recovery did not complete.");
  process.exit(setupCode);
}

const verificationCode = await runNodeScript("check-ncm-cookie.mjs");
process.exit(verificationCode);

function runNodeScript(filename) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scriptDir, filename)], {
      cwd: projectRoot,
      stdio: "inherit"
    });
    child.once("error", (error) => {
      console.error(`${filename} failed to start: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
