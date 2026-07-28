import { describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "@musicgpt/shared";
import { readChatEventStream } from "./api";

describe("chat event stream", () => {
  it("decodes NDJSON events even when network chunks split a Chinese delta", async () => {
    const encoder = new TextEncoder();
    const payload = [
      '{"type":"text_delta","delta":"好呀"}\n',
      '{"type":"speech","sequence":0,"text":"好呀","audioUrl":"/tts-cache/a.mp3"}\n',
      '{"type":"result","response":{"action":"noop","reply":"好呀","now":{"queue":[],"paused":false},"messages":[]}}\n'
    ].join("");
    const bytes = encoder.encode(payload);
    const splitInsideChinese = payload.indexOf("好") + 1;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, splitInsideChinese));
          controller.enqueue(bytes.slice(splitInsideChinese, 53));
          controller.enqueue(bytes.slice(53));
          controller.close();
        }
      }),
      { status: 200, headers: { "content-type": "application/x-ndjson" } }
    );
    const events: ChatStreamEvent[] = [];

    const result = await readChatEventStream(response, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual(["text_delta", "speech", "result"]);
    expect(events[0]).toEqual({ type: "text_delta", delta: "好呀" });
    expect(result.reply).toBe("好呀");
  });

  it("surfaces a streamed error instead of accepting a truncated response", async () => {
    const response = new Response('{"type":"error","message":"chat_stream_failed"}\n', {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });

    await expect(readChatEventStream(response, () => undefined)).rejects.toThrow(
      "chat_stream_failed"
    );
  });
});
