import { describe, expect, it } from "vitest";

import {
  createSpokenTextEvents,
  findMusicFunctionCalls,
  findWaitFunctionCallIds,
  RealtimeVoiceController
} from "./realtimeVoice";

describe("Realtime voice protocol", () => {
  it("asks the native audio model to speak text without an Edge TTS audio URL", () => {
    const events = createSpokenTextEvents("这首歌的鼓点很松，别急着切。", "dj-script-1");

    expect(events).toEqual([
      {
        event_id: "dj-script-1:response",
        type: "response.create",
        response: {
          conversation: "none",
          metadata: {
            source: "aurora-ui-spoken-text",
            request_id: "dj-script-1"
          },
          output_modalities: ["audio"],
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "这首歌的鼓点很松，别急着切。" }
              ]
            }
          ],
          tool_choice: "none",
          instructions: expect.stringContaining("自然地说出")
        }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("audioUrl");
    expect(JSON.stringify(events)).not.toContain("tts-cache");
  });

  it("reads completed music tool calls from a Realtime response", () => {
    expect(findMusicFunctionCalls({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "run_music_command",
            call_id: "call_123",
            arguments: "{\"request\":\"换一首更安静的\"}"
          }
        ]
      }
    })).toEqual([
      { callId: "call_123", request: "换一首更安静的" }
    ]);
  });

  it("recognizes a silent wait tool call for background music", () => {
    expect(findWaitFunctionCallIds({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            name: "wait_for_user",
            call_id: "call_wait",
            arguments: "{}"
          }
        ]
      }
    })).toEqual(["call_wait"]);
  });

  it("connects the microphone to the server SDP endpoint over WebRTC", async () => {
    const statuses: string[] = [];
    const sentEvents: string[] = [];
    const channel = new EventTarget() as RTCDataChannel;
    Object.defineProperties(channel, {
      readyState: { value: "connecting", writable: true },
      send: { value: (payload: string) => sentEvents.push(payload) },
      close: { value: () => undefined }
    });
    const track = { stop: () => undefined } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track]
    } as unknown as MediaStream;
    const peer = {
      addTrack: () => undefined,
      createDataChannel: () => channel,
      createOffer: async () => ({ type: "offer", sdp: "v=0\r\no=browser-offer" }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async () => {
        Object.defineProperty(channel, "readyState", { value: "open", writable: true });
        channel.dispatchEvent(new Event("open"));
      },
      close: () => undefined
    } as unknown as RTCPeerConnection;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(input).toBe("/api/realtime/session");
        return new Response(JSON.stringify({ enabled: true }), {
          headers: { "content-type": "application/json" }
        });
      }
      expect(input).toBe("/api/realtime/session");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: "v=0\r\no=browser-offer"
      });
      return new Response("v=0\r\no=openai-answer", {
        status: 201,
        headers: { "content-type": "application/sdp" }
      });
    };
    const audio = { autoplay: false, play: async () => undefined } as unknown as HTMLAudioElement;
    const controller = new RealtimeVoiceController(audio, {
      onStatusChange: (status) => statuses.push(status)
    }, {
      fetchFn,
      getUserMedia: async () => stream,
      createPeerConnection: () => peer
    });

    await controller.start();

    expect(controller.status).toBe("ready");
    expect(statuses).toEqual(["connecting", "ready"]);
    expect(audio.autoplay).toBe(true);
    expect(sentEvents).toEqual([]);
    controller.stop();
  });

  it("checks server availability before asking for microphone permission", async () => {
    let microphoneRequested = false;
    const controller = new RealtimeVoiceController(
      { autoplay: false, play: async () => undefined } as unknown as HTMLAudioElement,
      {},
      {
        fetchFn: async () => new Response(JSON.stringify({ enabled: false }), {
          headers: { "content-type": "application/json" }
        }),
        getUserMedia: async () => {
          microphoneRequested = true;
          throw new Error("should_not_request_microphone");
        },
        createPeerConnection: () => {
          throw new Error("should_not_create_peer");
        }
      }
    );

    await expect(controller.start()).rejects.toThrow("openai_realtime_not_configured");
    expect(microphoneRequested).toBe(false);
  });
});
