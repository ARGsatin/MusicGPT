import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_NCM_BASE_URL = "http://127.0.0.1:3001";
const envPath = path.resolve(process.cwd(), ".env");
const VERIFY_RETRY_COUNT = 3;
const VERIFY_RETRY_INTERVAL_MS = 1200;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

await main();

async function main() {
  if (!fs.existsSync(envPath)) {
    console.error(`.env not found: ${envPath}`);
    console.error("Please create .env first (copy from .env.example).");
    process.exit(1);
  }

  const env = readEnvMap(envPath);
  const baseUrl = normalizeBaseUrl(env.NCM_BASE_URL || DEFAULT_NCM_BASE_URL);
  const cookie = normalizeCookieHeader(String(env.NCM_COOKIE || "").trim());

  if (!cookie || /^PASTE_/i.test(cookie)) {
    console.error("NCM_COOKIE is empty or still placeholder in .env.");
    console.error("Run: npm run ncm:cookie");
    process.exit(2);
  }
  if (!cookie.includes("MUSIC_U=")) {
    console.error("NCM_COOKIE does not contain MUSIC_U. Please refresh via QR login.");
    process.exit(2);
  }

  const accountCheck = await verifyLoggedInAccount(baseUrl, cookie);
  if (!accountCheck.ok) {
    console.error(`Cookie validation failed: ${accountCheck.reason}`);
    console.error("Cookie is invalid or still anonymous.");
    process.exit(4);
  }

  const likeList = await requestJsonSafe(
    `${baseUrl}/likelist?uid=${accountCheck.userId}&timestamp=${Date.now()}`,
    {
      Cookie: cookie
    }
  );
  if (!likeList.ok) {
    console.error(`likelist fetch failed: ${likeList.errorMessage}`);
    process.exit(5);
  }

  const likeCount = Array.isArray(likeList.payload?.ids) ? likeList.payload.ids.length : 0;
  console.log(
    `NCM cookie check passed via ${accountCheck.source} (uid=${accountCheck.userId}, likes=${likeCount}).`
  );
}

function unwrapLoginStatusPayload(payload) {
  if (payload?.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload;
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
        errorMessage:
          (typeof payload === "object" && payload?.msg) || `Request failed (${response.status})`
      };
    }

    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
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

function normalizeBaseUrl(url) {
  return String(url).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log("Usage: npm run ncm:check");
  console.log("");
  console.log("Checks:");
  console.log("1) NCM API reachability");
  console.log("2) /login/status with NCM_COOKIE");
  console.log("3) /user/account with NCM_COOKIE");
  console.log("4) /likelist with real uid");
}
