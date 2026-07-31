import { describe, expect, it } from "vitest";

import type { ChatStreamEvent } from "@musicgpt/shared";
import { readChatEventStream } from "./api";
import { settleChatStreamFailure } from "./chatStream";

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

  it("reports an interrupted stream without leaking a JSON.parse error", async () => {
    const response = new Response(
      [
        '{"type":"text_delta","delta":"好呀"}\n',
        '{"type":"result","response":'
      ].join(""),
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" }
      }
    );
    const events: ChatStreamEvent[] = [];

    await expect(
      readChatEventStream(response, (event) => events.push(event))
    ).rejects.toThrow("Chat stream was interrupted");
    expect(events).toEqual([{ type: "text_delta", delta: "好呀" }]);
  });

  it("keeps delivered deltas observable when the network reader disconnects", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(encoder.encode('{"type":"text_delta","delta":"先听这段"}\n'));
            return;
          }
          controller.error(new Error("socket closed"));
        }
      }),
      { status: 200, headers: { "content-type": "application/x-ndjson" } }
    );
    const events: ChatStreamEvent[] = [];

    await expect(
      readChatEventStream(response, (event) => events.push(event))
    ).rejects.toThrow("Chat stream was interrupted");
    expect(events).toEqual([{ type: "text_delta", delta: "先听这段" }]);
  });

  it("keeps received text and marks a user-cancelled reply as stopped", () => {
    const messages = [
      { role: "user" as const, text: "来点爵士", at: "user-1" },
      { role: "assistant" as const, text: "那就从一首", at: "stream-1" }
    ];

    const settled = settleChatStreamFailure(messages, {
      kind: "stopped",
      streamAt: "stream-1",
      retryMessage: "来点爵士"
    });

    expect(settled.messages).toEqual(messages);
    expect(settled.feedback).toEqual({
      kind: "stopped",
      retryMessage: "来点爵士",
      hadPartialReply: true
    });
  });
});
