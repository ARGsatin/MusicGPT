import { describe, expect, it } from "vitest";

import {
  createSpokenTextEvents,
  findMusicFunctionCalls,
  findWaitFunctionCallIds,
  normalizeAnswerSdp,
  RealtimeVoiceController
} from "./realtimeVoice";

describe("Realtime voice protocol", () => {
  it("normalizes the Answer SDP to CRLF before WebRTC consumes it", () => {
    expect(normalizeAnswerSdp("v=0\no=qwen-answer\n")).toBe("v=0\r\no=qwen-answer\r\n");
  });

  it("asks the native audio model to speak text without an Edge TTS audio URL", () => {
    const events = createSpokenTextEvents("这首歌的鼓点很松，别急着切。", "dj-script-1");

    expect(events).toEqual([
      {
        event_id: "dj-script-1:session",
        type: "session.update",
        session: {
          tools: [],
          instructions: expect.stringContaining("这首歌的鼓点很松，别急着切。")
        }
      },
      {
        event_id: "dj-script-1:response",
        type: "response.create"
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

  it("reads Qwen function arguments as soon as their dedicated event completes", () => {
    expect(findMusicFunctionCalls({
      type: "response.function_call_arguments.done",
      name: "run_music_command",
      call_id: "call_qwen",
      arguments: "{\"request\":\"播放陈奕迅\"}"
    })).toEqual([
      { callId: "call_qwen", request: "播放陈奕迅" }
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
    const replaceTrackCalls: Array<MediaStreamTrack | null> = [];
    const channel = new EventTarget() as RTCDataChannel;
    Object.defineProperties(channel, {
      readyState: { value: "connecting", writable: true },
      send: {
        value: (payload: string) => {
          sentEvents.push(payload);
          const event = JSON.parse(payload) as { type?: string };
          if (event.type === "session.update") {
            channel.dispatchEvent(new MessageEvent("message", {
              data: JSON.stringify({ type: "session.updated" })
            }));
          }
        }
      },
      close: { value: () => undefined }
    });
    const track = { enabled: true, stop: () => undefined } as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track]
    } as unknown as MediaStream;
    const sender = {
      replaceTrack: async (next: MediaStreamTrack | null) => {
        replaceTrackCalls.push(next);
      }
    } as RTCRtpSender;
    const peer = {
      iceGatheringState: "complete",
      localDescription: { type: "offer", sdp: "v=0\r\no=browser-offer" },
      addTrack: () => sender,
      createDataChannel: () => channel,
      createOffer: async () => ({ type: "offer", sdp: "v=0\r\no=browser-offer" }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async () => {
        Object.defineProperty(channel, "readyState", { value: "open", writable: true });
        channel.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "session.created" })
        }));
      },
      close: () => undefined
    } as unknown as RTCPeerConnection;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        expect(input).toBe("/api/realtime/session");
        return new Response(JSON.stringify({
          enabled: true,
          session: {
            modalities: ["text", "audio"],
            voice: "Tina",
            turn_detection: { type: "server_vad" }
          }
        }), {
          headers: { "content-type": "application/json" }
        });
      }
      expect(input).toBe("/api/realtime/session");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: "v=0\r\no=browser-offer"
      });
      return new Response("v=0\r\no=qwen-answer", {
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
    expect(JSON.parse(sentEvents[0] ?? "{}")).toMatchObject({
      type: "session.update",
      session: { voice: "Tina", turn_detection: { type: "server_vad" } }
    });
    expect(replaceTrackCalls).toEqual([null, track]);
    expect(track.enabled).toBe(true);

    channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "response-new" } })
    }));
    channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" })
    }));
    channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "response.done",
        response: { id: "response-old", status: "completed", output: [] }
      })
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.status).toBe("listening");
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

    await expect(controller.start()).rejects.toThrow("dashscope_realtime_not_configured");
    expect(microphoneRequested).toBe(false);
  });
});
