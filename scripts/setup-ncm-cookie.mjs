import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_NCM_BASE_URL = "http://127.0.0.1:3001";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 300000;
const VERIFY_RETRY_COUNT = 10;
const VERIFY_RETRY_INTERVAL_MS = 2000;

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
  console.log("Open the QR image with NetEase Cloud Music app and confirm login.");
  console.log("Do not use WeChat scanner for this step.");
  console.log("Waiting for confirmation...");

  const rawCookie = await pollQrLoginCookie(baseUrl, qrKey);
  const cookie = normalizeCookieHeader(rawCookie);
  if (!cookie || !cookie.includes("MUSIC_U=")) {
    throw new Error("Login succeeded but returned cookie does not include MUSIC_U.");
  }

  const accountCheck = await verifyLoggedInAccount(baseUrl, cookie);
  if (!accountCheck.ok) {
    console.error(`Cookie validation failed: ${accountCheck.reason}`);
    console.error("Cookie is invalid or still anonymous. Please scan QR and confirm login again.");
    process.exit(2);
  }

  upsertEnvValue(envPath, "NCM_COOKIE", cookie);
  console.log("NCM_COOKIE updated in .env");
  console.log(
    `Account check passed via ${accountCheck.source} (uid=${accountCheck.userId}). NCM cookie is ready.`
  );
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

    const normalized = normalizeQrCheckPayload(result.payload);
    const code = normalized.code;
    const cookie = normalized.cookie;

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

function normalizeQrCheckPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { code: undefined, cookie: undefined };
  }

  const nested = payload.data && typeof payload.data === "object" ? payload.data : null;
  const code = nested?.code ?? payload.code;
  const cookie = nested?.cookie ?? payload.cookie;

  return { code, cookie };
}

function normalizeCookieHeader(cookieText) {
  const raw = String(cookieText || "").trim();
  if (!raw) {
    return "";
  }

  const attributeKeys = new Set([
    "path",
    "expires",
    "max-age",
    "domain",
    "samesite",
    "secure",
    "httponly",
    "priority",
    "partitioned"
  ]);
  const byKey = new Map();

  for (const token of raw.split(";")) {
    const part = token.trim();
    if (!part) continue;
    const idx = part.indexOf("=");
    if (idx <= 0) continue;

    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (attributeKeys.has(key.toLowerCase())) continue;

    byKey.set(key, value);
  }

  return [...byKey.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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

function unwrapLoginStatusPayload(payload) {
  if (payload?.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload;
}

async function verifyLoggedInAccount(baseUrl, cookie) {
  let lastReason = "unknown";

  for (let attempt = 1; attempt <= VERIFY_RETRY_COUNT; attempt += 1) {
    const [statusResult, accountResult] = await Promise.all([
      requestJsonSafe(`${baseUrl}/login/status?timestamp=${Date.now()}`, {
        Cookie: cookie
      }),
      requestJsonSafe(`${baseUrl}/user/account?timestamp=${Date.now()}`, {
        Cookie: cookie
      })
    ]);

    if (statusResult.ok) {
      const statusPayload = unwrapLoginStatusPayload(statusResult.payload);
      const statusCheck = validateAccountPayload(statusPayload);
      if (statusCheck.ok) {
        return { ok: true, userId: statusCheck.userId, source: "/login/status" };
      }
      lastReason = `/login/status: ${statusCheck.reason}`;
    } else {
      lastReason = `/login/status request failed: ${statusResult.errorMessage}`;
    }

    if (accountResult.ok) {
      const accountCheck = validateAccountPayload(accountResult.payload);
      if (accountCheck.ok) {
        return { ok: true, userId: accountCheck.userId, source: "/user/account" };
      }
      lastReason = `${lastReason}; /user/account: ${accountCheck.reason}`;
    } else {
      lastReason = `${lastReason}; /user/account request failed: ${accountResult.errorMessage}`;
    }

    if (attempt < VERIFY_RETRY_COUNT) {
      await sleep(VERIFY_RETRY_INTERVAL_MS);
    }
  }

  return { ok: false, reason: lastReason };
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
