import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_NCM_BASE_URL = "http://127.0.0.1:3001";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300000;

const envPath = path.resolve(process.cwd(), ".env");
const envExamplePath = path.resolve(process.cwd(), ".env.example");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

await main();

async function main() {
  ensureEnvFile();
  const env = readEnvMap(envPath);
  const baseUrl = normalizeBaseUrl(env.NCM_BASE_URL || DEFAULT_NCM_BASE_URL);

  const loginStatus = await safeRequest(`${baseUrl}/login/status?timestamp=${Date.now()}`);
  if (!loginStatus.ok) {
    console.error("NCM API is not reachable.");
    console.error(`Expected: ${baseUrl}`);
    console.error("Please start it first: npm run dev:ncm");
    process.exit(1);
  }

  console.log(`NCM API reachable: ${baseUrl}`);
  console.log("Creating QR login session...");

  const keyPayload = await requestJson(`${baseUrl}/login/qr/key?timestamp=${Date.now()}`);
  const qrKey = keyPayload?.data?.unikey;
  if (!qrKey) {
    throw new Error("Failed to get QR key from /login/qr/key");
  }

  const qrPayload = await requestJson(
    `${baseUrl}/login/qr/create?key=${encodeURIComponent(qrKey)}&qrimg=true&timestamp=${Date.now()}`
  );
  const qrImg = qrPayload?.data?.qrimg;
  const qrUrl = qrPayload?.data?.qrurl;
  const qrImagePath = path.resolve(process.cwd(), ".ncm-login-qr.png");

  if (typeof qrImg === "string" && qrImg.startsWith("data:image/png;base64,")) {
    const base64 = qrImg.slice("data:image/png;base64,".length);
    fs.writeFileSync(qrImagePath, Buffer.from(base64, "base64"));
    console.log(`QR image saved: ${qrImagePath}`);
  }

  if (qrUrl) {
    console.log(`QR url: ${qrUrl}`);
  }
  console.log("Open the QR image with WeChat/NetEase app and confirm login.");
  console.log("Waiting for confirmation...");

  const cookie = await pollQrLoginCookie(baseUrl, qrKey);
  if (!cookie || !cookie.includes("MUSIC_U=")) {
    throw new Error("Login succeeded but returned cookie does not include MUSIC_U.");
  }

  const accountPayload = await requestJson(`${baseUrl}/user/account?timestamp=${Date.now()}`, {
    Cookie: cookie
  });
  const accountCheck = validateAccountPayload(accountPayload);
  if (!accountCheck.ok) {
    console.error(`Cookie validation failed: ${accountCheck.reason}`);
    console.error("Cookie is invalid or still anonymous. Please scan QR and confirm login again.");
    process.exit(2);
  }

  upsertEnvValue(envPath, "NCM_COOKIE", cookie);
  console.log("NCM_COOKIE updated in .env");
  console.log(`Account check passed (uid=${accountCheck.userId}). NCM cookie is ready.`);
}

async function pollQrLoginCookie(baseUrl, qrKey) {
  const start = Date.now();
  let lastCode;
  let transientErrorCount = 0;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const result = await requestJsonSafe(
      `${baseUrl}/login/qr/check?key=${encodeURIComponent(qrKey)}&timestamp=${Date.now()}`
    );

    if (!result.ok) {
      transientErrorCount += 1;
      const brief =
        result.errorMessage ||
        (typeof result.payload === "object" && result.payload?.msg ? result.payload.msg : null) ||
        `http_${result.status ?? "unknown"}`;
      console.warn(`Transient qr/check error #${transientErrorCount}: ${brief}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const data = result.payload?.data ?? {};
    const code = data.code;
    const cookie = data.cookie;

    if (code !== lastCode) {
      const message = codeToMessage(code);
      if (message) {
        console.log(message);
      }
      lastCode = code;
    }

    if (code === 803 && cookie) {
      return cookie;
    }
    if (code === 800) {
      throw new Error("QR code expired. Please run the script again.");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("QR login timed out. Please run the script again.");
}

function codeToMessage(code) {
  if (code === 801) return "Waiting for scan...";
  if (code === 802) return "Scanned. Please confirm on phone...";
  if (code === 803) return "Login confirmed.";
  if (code === 800) return "QR code expired.";
  return null;
}

async function safeRequest(url, headers = undefined) {
  try {
    const response = await fetch(url, {
      headers: headers || {},
      signal: AbortSignal.timeout(6000)
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function requestJson(url, headers = undefined) {
  const response = await fetch(url, {
    headers: headers || {},
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return response.json();
}

async function requestJsonSafe(url, headers = undefined) {
  try {
    const response = await fetch(url, {
      headers: headers || {},
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    const payload = safeJsonParse(text);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        payload,
        errorMessage:
          (typeof payload === "object" && payload?.msg) || `Request failed (${response.status})`
      };
    }

    return { ok: true, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function validateAccountPayload(payload) {
  const userId = payload?.profile?.userId;
  const isAnonymous = payload?.account?.anonimousUser ?? payload?.account?.anonymousUser;
  const status = payload?.account?.status;

  if (!userId) {
    return {
      ok: false,
      reason: "profile.userId is missing"
    };
  }
  if (isAnonymous === true) {
    return {
      ok: false,
      reason: "account is anonymous (anonimousUser=true)"
    };
  }
  if (status === -10) {
    return {
      ok: false,
      reason: "account status is -10 (guest/invalid session)"
    };
  }

  return {
    ok: true,
    userId
  };
}

function normalizeBaseUrl(url) {
  return String(url).replace(/\/+$/, "");
}

function ensureEnvFile() {
  if (fs.existsSync(envPath)) {
    return;
  }
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    return;
  }
  fs.writeFileSync(
    envPath,
    `NCM_BASE_URL=${DEFAULT_NCM_BASE_URL}\nNCM_COOKIE=\nOPENAI_API_KEY=\n`,
    "utf8"
  );
}

function readEnvMap(targetPath) {
  const output = {};
  const text = fs.readFileSync(targetPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    output[key] = value;
  }
  return output;
}

function upsertEnvValue(targetPath, key, value) {
  const text = fs.readFileSync(targetPath, "utf8");
  const lines = text.split(/\r?\n/);
  const next = [];
  let replaced = false;
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      next.push(`${key}=${value}`);
      replaced = true;
    } else {
      next.push(line);
    }
  }
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push(`${key}=${value}`);
  }
  fs.writeFileSync(targetPath, `${next.join("\n").replace(/\n*$/, "\n")}`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log("Usage: npm run ncm:cookie");
  console.log("");
  console.log("What it does:");
  console.log("1) Calls NCM API QR login endpoints");
  console.log("2) Saves QR image to .ncm-login-qr.png");
  console.log("3) Polls for confirmation");
  console.log("4) Overwrites NCM_COOKIE in .env");
  console.log("5) Verifies /user/account with the new cookie");
}
