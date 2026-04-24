import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_NCM_BASE_URL = "http://127.0.0.1:3001";
const envPath = path.resolve(process.cwd(), ".env");

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
  const cookie = String(env.NCM_COOKIE || "").trim();

  if (!cookie || /^PASTE_/i.test(cookie)) {
    console.error("NCM_COOKIE is empty or still placeholder in .env.");
    console.error("Run: npm run ncm:cookie");
    process.exit(2);
  }

  const loginStatus = await requestJsonSafe(`${baseUrl}/login/status?timestamp=${Date.now()}`, {
    Cookie: cookie
  });
  if (!loginStatus.ok) {
    console.error(`NCM API unreachable or login/status failed: ${loginStatus.errorMessage}`);
    console.error(`Expected NCM API base URL: ${baseUrl}`);
    process.exit(3);
  }

  const loginStatusPayload = unwrapLoginStatusPayload(loginStatus.payload);
  const loginStatusCheck = validateAccountPayload(loginStatusPayload);
  if (!loginStatusCheck.ok) {
    console.error(`login/status check failed: ${loginStatusCheck.reason}`);
    console.error("Cookie is invalid or still anonymous.");
    process.exit(4);
  }

  const account = await requestJsonSafe(`${baseUrl}/user/account?timestamp=${Date.now()}`, {
    Cookie: cookie
  });
  if (!account.ok) {
    console.error(`user/account failed: ${account.errorMessage}`);
    process.exit(5);
  }
  const accountCheck = validateAccountPayload(account.payload);
  if (!accountCheck.ok) {
    console.error(`user/account check failed: ${accountCheck.reason}`);
    console.error("Cookie is invalid or still anonymous.");
    process.exit(6);
  }

  const likeList = await requestJsonSafe(
    `${baseUrl}/likelist?uid=${accountCheck.userId}&timestamp=${Date.now()}`,
    {
      Cookie: cookie
    }
  );
  if (!likeList.ok) {
    console.error(`likelist fetch failed: ${likeList.errorMessage}`);
    process.exit(7);
  }

  const likeCount = Array.isArray(likeList.payload?.ids) ? likeList.payload.ids.length : 0;
  console.log(`NCM cookie check passed (uid=${accountCheck.userId}, likes=${likeCount}).`);
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

function printHelp() {
  console.log("Usage: npm run ncm:check");
  console.log("");
  console.log("Checks:");
  console.log("1) NCM API reachability");
  console.log("2) /login/status with NCM_COOKIE");
  console.log("3) /user/account with NCM_COOKIE");
  console.log("4) /likelist with real uid");
}
