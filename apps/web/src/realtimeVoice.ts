import { API_ROUTES } from "@musicgpt/shared";

export interface RealtimeMusicFunctionCall {
  callId: string;
  request: string;
}

export type RealtimeVoiceStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface RealtimeVoiceCallbacks {
  onStatusChange?: (status: RealtimeVoiceStatus) => void;
  onError?: (error: Error) => void;
  onMusicCommand?: (request: string) => Promise<unknown>;
}

export interface RealtimeVoiceDependencies {
  fetchFn: typeof fetch;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
}

type RealtimeClientEvent = Record<string, unknown>;

export function createSpokenTextEvents(text: string, requestId: string): RealtimeClientEvent[] {
  return [
    {
      event_id: `${requestId}:response`,
      type: "response.create",
      response: {
        conversation: "none",
        metadata: {
          source: "aurora-ui-spoken-text",
          request_id: requestId
        },
        output_modalities: ["audio"],
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }]
          }
        ],
        tool_choice: "none",
        instructions:
          "把用户刚发来的文字自然地说出来。保持原意和语言，不要加开场白、解释、总结或播音腔。"
      }
    }
  ];
}

export function findMusicFunctionCalls(event: unknown): RealtimeMusicFunctionCall[] {
  if (!event || typeof event !== "object") {
    return [];
  }
  const candidate = event as {
    type?: unknown;
    response?: { output?: unknown };
  };
  if (candidate.type !== "response.done" || !Array.isArray(candidate.response?.output)) {
    return [];
  }

  const calls: RealtimeMusicFunctionCall[] = [];
  for (const output of candidate.response.output) {
    if (!output || typeof output !== "object") {
      continue;
    }
    const item = output as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
      arguments?: unknown;
    };
    if (
      item.type !== "function_call" ||
      item.name !== "run_music_command" ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    ) {
      continue;
    }
    try {
      const args = JSON.parse(item.arguments) as { request?: unknown };
      if (typeof args.request === "string" && args.request.trim()) {
        calls.push({ callId: item.call_id, request: args.request.trim() });
      }
    } catch {
      // Invalid model arguments are ignored; the server will surface a protocol error separately.
    }
  }
  return calls;
}

export function findWaitFunctionCallIds(event: unknown): string[] {
  if (!event || typeof event !== "object") {
    return [];
  }
  const candidate = event as {
    type?: unknown;
    response?: { output?: unknown };
  };
  if (candidate.type !== "response.done" || !Array.isArray(candidate.response?.output)) {
    return [];
  }
  return candidate.response.output.flatMap((output) => {
    if (!output || typeof output !== "object") {
      return [];
    }
    const item = output as {
      type?: unknown;
      name?: unknown;
      call_id?: unknown;
    };
    return item.type === "function_call" &&
      item.name === "wait_for_user" &&
      typeof item.call_id === "string"
      ? [item.call_id]
      : [];
  });
}

function defaultDependencies(): RealtimeVoiceDependencies {
  return {
    fetchFn: globalThis.fetch.bind(globalThis),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection()
  };
}

export class RealtimeVoiceController {
  status: RealtimeVoiceStatus = "idle";

  private peer: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private microphone: MediaStream | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly handledCallIds = new Set<string>();

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly callbacks: RealtimeVoiceCallbacks = {},
    private readonly dependencies: RealtimeVoiceDependencies = defaultDependencies()
  ) {}

  get connected(): boolean {
    return this.channel?.readyState === "open";
  }

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.connect();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  stop(): void {
    this.channel?.close();
    this.peer?.close();
    for (const track of this.microphone?.getTracks() ?? []) {
      track.stop();
    }
    this.channel = undefined;
    this.peer = undefined;
    this.microphone = undefined;
    this.audio.srcObject = null;
    this.handledCallIds.clear();
    this.setStatus("idle");
  }

  async speakText(text: string, requestId = `speak-${Date.now()}`): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    await this.start();
    for (const event of createSpokenTextEvents(normalized, requestId)) {
      this.sendEvent(event);
    }
  }

  private async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      const availabilityResponse = await this.dependencies.fetchFn(API_ROUTES.realtimeSession, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!availabilityResponse.ok) {
        throw new Error(`realtime_status_failed:${availabilityResponse.status}`);
      }
      const availability = await availabilityResponse.json() as { enabled?: unknown };
      if (availability.enabled !== true) {
        throw new Error("openai_realtime_not_configured");
      }
      const microphone = await this.dependencies.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      const peer = this.dependencies.createPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      this.microphone = microphone;
      this.peer = peer;
      this.channel = channel;
      this.audio.autoplay = true;

      peer.ontrack = (event) => {
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.audio.play().catch(() => undefined);
      };
      channel.addEventListener("message", (event) => {
        void this.handleServerMessage(String(event.data));
      });
      channel.addEventListener("close", () => {
        if (this.status !== "idle") {
          this.setStatus("idle");
        }
      });
      const opened = waitForDataChannelOpen(channel);

      const track = microphone.getAudioTracks()[0];
      if (!track) {
        throw new Error("microphone_has_no_audio_track");
      }
      peer.addTrack(track, microphone);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) {
        throw new Error("webrtc_offer_missing_sdp");
      }
      const response = await this.dependencies.fetchFn(API_ROUTES.realtimeSession, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: offer.sdp
      });
      const answerSdp = await response.text();
      if (!response.ok) {
        let message = `realtime_session_failed:${response.status}`;
        try {
          const payload = JSON.parse(answerSdp) as { error?: unknown };
          if (typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // The status code remains enough context for non-JSON failures.
        }
        throw new Error(message);
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await opened;
      this.setStatus("ready");
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("realtime_connection_failed");
      this.channel?.close();
      this.peer?.close();
      for (const track of this.microphone?.getTracks() ?? []) {
        track.stop();
      }
      this.channel = undefined;
      this.peer = undefined;
      this.microphone = undefined;
      this.setStatus("error");
      this.callbacks.onError?.(normalized);
      throw normalized;
    }
  }

  private async handleServerMessage(payload: string): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const type = getEventType(event);
    if (type === "input_audio_buffer.speech_started") {
      this.setStatus("listening");
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.setStatus("thinking");
    } else if (type === "response.output_audio.delta" || type === "output_audio_buffer.started") {
      this.setStatus("speaking");
    } else if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
      this.setStatus("ready");
    } else if (type === "error") {
      const message = getRealtimeErrorMessage(event);
      const error = new Error(message);
      this.setStatus("error");
      this.callbacks.onError?.(error);
    }

    const waitCallIds = findWaitFunctionCallIds(event).filter((callId) => !this.handledCallIds.has(callId));
    for (const callId of waitCallIds) {
      this.handledCallIds.add(callId);
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ ok: true })
        }
      });
    }

    const calls = findMusicFunctionCalls(event).filter((call) => !this.handledCallIds.has(call.callId));
    if (calls.length > 0) {
      this.setStatus("thinking");
      for (const call of calls) {
        this.handledCallIds.add(call.callId);
        await this.completeMusicFunctionCall(call);
      }
    } else if (type === "response.done" && this.status !== "speaking") {
      this.setStatus("ready");
    }
  }

  private async completeMusicFunctionCall(call: RealtimeMusicFunctionCall): Promise<void> {
    let output: unknown;
    try {
      if (!this.callbacks.onMusicCommand) {
        throw new Error("music_command_handler_unavailable");
      }
      output = { ok: true, result: await this.callbacks.onMusicCommand(call.request) };
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : "music_command_failed"
      };
    }
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify(output)
      }
    });
    this.sendEvent({ type: "response.create" });
  }

  private sendEvent(event: RealtimeClientEvent): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new Error("realtime_data_channel_not_open");
    }
    this.channel.send(JSON.stringify(event));
  }

  private setStatus(status: RealtimeVoiceStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}

function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("realtime_data_channel_timeout"));
    }, 15_000);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("realtime_data_channel_closed"));
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
  });
}

function getEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function getRealtimeErrorMessage(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "realtime_protocol_error";
  }
  const candidate = event as { error?: { message?: unknown }; message?: unknown };
  if (typeof candidate.error?.message === "string") {
    return candidate.error.message;
  }
  if (typeof candidate.message === "string") {
    return candidate.message;
  }
  return "realtime_protocol_error";
}
