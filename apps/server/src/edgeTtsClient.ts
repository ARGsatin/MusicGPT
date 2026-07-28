import crypto from "node:crypto";
import fs from "node:fs/promises";

import WebSocket, { type RawData } from "ws";

const EDGE_TTS_BASE_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".", 1)[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WINDOWS_EPOCH_SECONDS = 11_644_473_600;
const FIVE_MINUTES_SECONDS = 300;
const TICKS_PER_SECOND = 10_000_000n;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface EdgeTtsOptions {
  voice?: string;
  volume?: string;
  rate?: string;
  pitch?: string;
}

export function generateSecMsGec(nowMs = Date.now()): string {
  const unixSeconds = Math.floor(nowMs / 1_000);
  const roundedSeconds = unixSeconds - (unixSeconds % FIVE_MINUTES_SECONDS);
  const windowsTicks =
    BigInt(roundedSeconds + WINDOWS_EPOCH_SECONDS) * TICKS_PER_SECOND;
  return crypto
    .createHash("sha256")
    .update(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

export function buildEdgeTtsWebSocketUrl(
  nowMs = Date.now(),
  connectionId = createConnectionId()
): string {
  const url = new URL(EDGE_TTS_BASE_URL);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("Sec-MS-GEC", generateSecMsGec(nowMs));
  url.searchParams.set("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION);
  url.searchParams.set("ConnectionId", connectionId);
  return url.toString();
}

export function extractEdgeTtsAudioPayload(frame: Buffer): Buffer | undefined {
  if (frame.length < 2) {
    return undefined;
  }
  const headerLength = frame.readUInt16BE(0);
  const payloadOffset = headerLength + 2;
  if (headerLength === 0 || payloadOffset > frame.length) {
    return undefined;
  }
  const headers = frame.subarray(2, payloadOffset).toString("utf8");
  const isAudio = headers
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase() === "path:audio");
  if (!isAudio || payloadOffset === frame.length) {
    return undefined;
  }
  return frame.subarray(payloadOffset);
}

export async function synthesizeEdgeTts(
  text: string,
  options: EdgeTtsOptions = {}
): Promise<Buffer> {
  const {
    voice = "zh-CN-XiaoxiaoNeural",
    volume = "+0%",
    rate = "+0%",
    pitch = "+0Hz"
  } = options;
  const connectionId = createConnectionId();
  const requestId = createConnectionId();
  const timestamp = javascriptUtcDate();
  const ssml = [
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>",
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>`,
    text,
    "</prosody></voice></speak>"
  ].join("");
  const speechConfig = [
    `X-Timestamp:${timestamp}\r\n`,
    "Content-Type:application/json; charset=utf-8\r\n",
    "Path:speech.config\r\n\r\n",
    '{"context":{"synthesis":{"audio":{"metadataoptions":',
    '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},',
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  ].join("");
  const ssmlRequest = [
    `X-RequestId:${requestId}\r\n`,
    "Content-Type:application/ssml+xml\r\n",
    `X-Timestamp:${timestamp}Z\r\n`,
    "Path:ssml\r\n\r\n",
    ssml
  ].join("");

  return new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let settled = false;
    const websocket = new WebSocket(buildEdgeTtsWebSocketUrl(Date.now(), connectionId), {
      origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent":
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
          `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
          `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};`
      },
      handshakeTimeout: 10_000,
      perMessageDeflate: { clientMaxWindowBits: 15 }
    });
    const timeout = setTimeout(() => {
      fail(new Error("Edge TTS synthesis timed out"));
    }, DEFAULT_TIMEOUT_MS);

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      websocket.close();
      if (audioChunks.length === 0) {
        reject(new Error("Edge TTS returned no audio"));
      } else {
        resolve(Buffer.concat(audioChunks));
      }
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      websocket.terminate();
      reject(error);
    };

    websocket.on("open", () => {
      websocket.send(speechConfig, { compress: true }, (configError) => {
        if (configError) {
          fail(configError);
          return;
        }
        websocket.send(ssmlRequest, { compress: true }, (ssmlError) => {
          if (ssmlError) {
            fail(ssmlError);
          }
        });
      });
    });
    websocket.on("message", (rawData: RawData, isBinary: boolean) => {
      const data = toBuffer(rawData);
      if (isBinary) {
        const audio = extractEdgeTtsAudioPayload(data);
        if (audio) {
          audioChunks.push(audio);
        }
        return;
      }
      if (getMessagePath(data.toString("utf8")) === "turn.end") {
        finish();
      }
    });
    websocket.on("unexpected-response", (_request, response) => {
      response.resume();
      fail(new Error(`Edge TTS handshake failed with HTTP ${response.statusCode ?? "unknown"}`));
    });
    websocket.on("error", (error) => fail(error));
    websocket.on("close", () => {
      if (!settled) {
        fail(new Error("Edge TTS connection closed before synthesis completed"));
      }
    });
  });
}

export async function saveEdgeTts(
  text: string,
  filePath: string,
  options: EdgeTtsOptions = {}
): Promise<void> {
  await fs.writeFile(filePath, await synthesizeEdgeTts(text, options));
}

function createConnectionId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function javascriptUtcDate(now = new Date()): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${weekdays[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${pad(
    now.getUTCDate()
  )} ${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(
    now.getUTCMinutes()
  )}:${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function getMessagePath(message: string): string | undefined {
  const headerEnd = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, headerEnd < 0 ? message.length : headerEnd);
  for (const line of headers.split(/\r?\n/)) {
    const [key, value] = line.split(":", 2);
    if (key?.trim().toLowerCase() === "path") {
      return value?.trim().toLowerCase();
    }
  }
  return undefined;
}

function toBuffer(rawData: RawData): Buffer {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData);
  }
  return Buffer.from(rawData);
}
