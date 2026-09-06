import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedRoot = process.env.MUSICGPT_MAIN_CHECKOUT?.trim();
const mainRoot = requestedRoot
  ? path.resolve(requestedRoot)
  : resolveMainWorktree(scriptRoot);
const branch = git(mainRoot, "branch", "--show-current");
const release = git(mainRoot, "rev-parse", "HEAD");

if (branch !== "main") {
  fail(`Refusing to start the live stack from ${mainRoot}: expected branch main, found ${branch || "detached HEAD"}.`);
}
if (!fs.existsSync(path.join(mainRoot, "package.json"))) {
  fail(`MusicGPT package.json was not found in the main checkout: ${mainRoot}`);
}
if (!fs.existsSync(path.join(mainRoot, ".env"))) {
  fail(`Local secrets were not found at ${path.join(mainRoot, ".env")}. Restore that existing file before starting; this launcher never creates or replaces it.`);
}

console.log(`MusicGPT live checkout: ${mainRoot}`);
console.log(`MusicGPT live release: ${release}`);

if (process.argv.includes("--check")) {
  console.log("Main-checkout deployment check passed.");
  process.exit(0);
}

const child = startNpm(mainRoot, ["run", "dev:full"], {
  ...process.env,
  MUSICGPT_RELEASE: release,
  MUSICGPT_CHECKOUT: "main"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child.exitCode === null) {
      stopChildTree(child, signal);
    }
  });
}

child.on("error", (error) => fail(`Could not start MusicGPT from ${mainRoot}: ${error.message}`));
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`MusicGPT supervisor stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function resolveMainWorktree(fromRoot) {
  const result = spawnSync("git", ["-C", fromRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    fail(`Could not inspect Git worktrees: ${(result.stderr || result.stdout).trim()}`);
  }

  let candidate;
  let worktree;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      worktree = line.slice("worktree ".length).trim();
    } else if (line === "branch refs/heads/main") {
      candidate = worktree;
    }
  }
  if (!candidate) {
    fail("No Git worktree registered for branch main. Create or restore the main checkout before starting MusicGPT.");
  }
  return path.resolve(candidate);
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    fail(`Git ${args.join(" ")} failed in ${root}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function startNpm(cwd, args, env) {
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], {
      cwd,
      env,
      stdio: "inherit",
      windowsHide: false
    });
  }
  return spawn("npm", args, { cwd, env, stdio: "inherit" });
}

function stopChildTree(target, signal) {
  if (process.platform === "win32" && target.pid) {
    spawnSync("taskkill.exe", ["/PID", String(target.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  target.kill(signal);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
