// Local, explicitly invoked acceptance: changes playback and adds two chat turns.
// Does not persist response drafts, credentials, audio URLs, or conversation text.
import assert from "node:assert/strict";

const base = "http://127.0.0.1:8787";
const health = await get("/health");
assert.equal(health.checkout, "main");
assert.match(health.runningRoot.replaceAll("\\", "/"), /^D:\/MusicGPT\/apps\/server$/u);
const before = await get("/api/now");
const target = before.queue.find((item) => item.track.source !== "qq")?.track;
assert.ok(target, "a playable NCM queue target is required");
const key = target.trackKey ?? `ncm:${target.id}`;
const command = await stream(`播放 ${key}`);
assert.equal(command.result.now.track.trackKey, key);
assert.equal(command.result.command.outcome, "executed");
const chat = await stream("只聊天：用两句话说说音乐里的留白。");
assert.equal(chat.result.action, "noop");
assert.equal(chat.result.now.track.trackKey, key);
assert.ok(chat.deltas > 1, "ordinary chat must contain multiple actual deltas");
assert.ok(chat.firstDeltaMs < chat.resultMs, "deltas must arrive before the completed result");
console.log(JSON.stringify({
  ok: true, checkout: health.checkout, runningRoot: health.runningRoot, release: health.release,
  explicitPlayback: { previous: before.track?.title, requested: target.title, actual: command.result.now.track.title, outcome: command.result.command.outcome },
  ordinaryChat: { deltas: chat.deltas, firstDeltaMs: chat.firstDeltaMs, resultMs: chat.resultMs, currentUnchanged: true }
}, null, 2));

async function get(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok);
  return response.json();
}

async function stream(message) {
  const start = performance.now();
  const response = await fetch(`${base}/api/chat/stream`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, turnId: `acceptance-${crypto.randomUUID()}` }),
    signal: AbortSignal.timeout(120000)
  });
  assert.ok(response.ok);
  const decoder = new TextDecoder();
  let buffer = "", deltas = 0, firstDeltaMs, resultMs, result;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === "text_delta") { deltas++; firstDeltaMs ??= Math.round(performance.now() - start); }
      if (event.type === "result") { result = event.response; resultMs = Math.round(performance.now() - start); }
    }
  }
  assert.ok(result, "stream did not finish with a result");
  return { result, deltas, firstDeltaMs, resultMs };
}
