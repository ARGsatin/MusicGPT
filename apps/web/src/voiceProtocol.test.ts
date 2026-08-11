import { describe, expect, it } from "vitest";

import { parseVoiceProtocolEvents } from "./voiceProtocol";

describe("voice protocol normalization", () => {
  it("combines Qwen text and stash into one provisional preview", () => {
    expect(parseVoiceProtocolEvents({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      text: "给我放一首",
      stash: "陈奕迅"
    })).toEqual([{ type: "user_preview", itemId: "item-1", text: "给我放一首陈奕迅" }]);
  });

  it("normalizes final and failed input transcription events", () => {
    expect(parseVoiceProtocolEvents({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "继续播放"
    })).toEqual([{ type: "user_final", itemId: "item-2", transcript: "继续播放" }]);
    expect(parseVoiceProtocolEvents({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-2"
    })).toEqual([{ type: "user_failed", itemId: "item-2" }]);
  });

  it("falls back to response output when audio transcript done is absent", () => {
    expect(parseVoiceProtocolEvents({
      type: "response.done",
      response: {
        id: "response-1",
        status: "completed",
        output: [{ type: "message", content: [{ type: "audio", transcript: "已经为你播放。" }] }]
      }
    })).toContainEqual({
      type: "response_done",
      responseId: "response-1",
      status: "completed",
      transcript: "已经为你播放。"
    });
  });

  it("normalizes dedicated and final function calls under the same call id", () => {
    const dedicated = parseVoiceProtocolEvents({
      type: "response.function_call_arguments.done",
      name: "run_music_command",
      call_id: "call-1",
      arguments: JSON.stringify({ request: "播放第一首", confirmationToken: "token", selectedTrackId: 42 })
    });
    const final = parseVoiceProtocolEvents({
      type: "response.done",
      response: {
        id: "response-2",
        output: [{
          type: "function_call",
          name: "run_music_command",
          call_id: "call-1",
          arguments: JSON.stringify({ request: "播放第一首", confirmationToken: "token", selectedTrackId: 42 })
        }]
      }
    });
    expect(dedicated[0]).toEqual(final[0]);
  });

  it("does not synthesize a completed assistant turn for wait_for_user", () => {
    expect(parseVoiceProtocolEvents({
      type: "response.done",
      response: {
        id: "response-wait",
        output: [{ type: "function_call", name: "wait_for_user", call_id: "wait-1", arguments: "{}" }]
      }
    })).toEqual([{ type: "wait", callId: "wait-1" }]);
  });
});
