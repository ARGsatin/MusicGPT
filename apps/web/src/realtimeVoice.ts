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
type RealtimeSessionConfig = Record<string, unknown>;

export function createSpokenTextEvents(text: string, requestId: string): RealtimeClientEvent[] {
  return [
    {
      event_id: `${requestId}:session`,
      type: "session.update",
      session: {
        tools: [],
        instructions:
          `你现在只执行一次朗读任务。自然地说出下面内容，保持原意和语言，不要加开场白、解释、总结或播音腔。\n\n${text}`
      }
    },
    {
      event_id: `${requestId}:response`,
      type: "response.create"
    }
  ];
}

export function findMusicFunctionCalls(event: unknown): RealtimeMusicFunctionCall[] {
  if (!event || typeof event !== "object") {
    return [];
  }
  const candidate = event as {
    type?: unknown;
    name?: unknown;
    call_id?: unknown;
    arguments?: unknown;
    response?: { output?: unknown };
  };
  if (candidate.type === "response.function_call_arguments.done") {
    const directCall = parseMusicFunctionCall(candidate);
    return directCall ? [directCall] : [];
  }
  if (candidate.type !== "response.done" || !Array.isArray(candidate.response?.output)) {
    return [];
  }

  const calls: RealtimeMusicFunctionCall[] = [];
  for (const output of candidate.response.output) {
    if (!output || typeof output !== "object") {
      continue;
    }
    const call = parseMusicFunctionCall(output);
    if (call) {
      calls.push(call);
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
    name?: unknown;
    call_id?: unknown;
    response?: { output?: unknown };
  };
  if (candidate.type === "response.function_call_arguments.done") {
    return candidate.name === "wait_for_user" && typeof candidate.call_id === "string"
      ? [candidate.call_id]
      : [];
  }
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

function parseMusicFunctionCall(event: unknown): RealtimeMusicFunctionCall | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const item = event as {
    type?: unknown;
    name?: unknown;
    call_id?: unknown;
    arguments?: unknown;
  };
  const supportedType = item.type === "function_call" ||
    item.type === "response.function_call_arguments.done";
  if (
    !supportedType ||
    item.name !== "run_music_command" ||
    typeof item.call_id !== "string" ||
    typeof item.arguments !== "string"
  ) {
    return undefined;
  }
  try {
    const args = JSON.parse(item.arguments) as { request?: unknown };
    return typeof args.request === "string" && args.request.trim()
      ? { callId: item.call_id, request: args.request.trim() }
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultDependencies(): RealtimeVoiceDependencies {
  return {
    fetchFn: globalThis.fetch.bind(globalThis),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection({ iceServers: [] })
  };
}

export class RealtimeVoiceController {
  status: RealtimeVoiceStatus = "idle";

  private peer: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private readonly channels = new Set<RTCDataChannel>();
  private microphone: MediaStream | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly handledCallIds = new Set<string>();
  private sessionConfig: RealtimeSessionConfig | undefined;
  private sessionUpdateSent = false;
  private sessionReadyResolve: (() => void) | undefined;
  private sessionReadyReject: ((error: Error) => void) | undefined;
  private sessionReadyTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private restoreSessionAfterResponse = false;

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
    for (const channel of this.channels) {
      channel.close();
    }
    this.peer?.close();
    for (const track of this.microphone?.getTracks() ?? []) {
      track.stop();
    }
    this.channel = undefined;
    this.channels.clear();
    this.peer = undefined;
    this.microphone = undefined;
    this.sessionConfig = undefined;
    this.sessionUpdateSent = false;
    this.restoreSessionAfterResponse = false;
    this.rejectSessionReady(new Error("realtime_session_stopped"));
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
    if (this.restoreSessionAfterResponse) {
      throw new Error("realtime_speech_busy");
    }
    this.restoreSessionAfterResponse = true;
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
      const availability = await availabilityResponse.json() as {
        enabled?: unknown;
        session?: unknown;
      };
      if (availability.enabled !== true) {
        throw new Error("dashscope_realtime_not_configured");
      }
      if (!availability.session || typeof availability.session !== "object") {
        throw new Error("dashscope_realtime_session_config_missing");
      }
      this.sessionConfig = availability.session as RealtimeSessionConfig;
      this.sessionUpdateSent = false;
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
      this.attachRealtimeChannel(channel);
      peer.ondatachannel = (event) => {
        this.attachRealtimeChannel(event.channel);
      };

      const track = microphone.getAudioTracks()[0];
      if (!track) {
        throw new Error("microphone_has_no_audio_track");
      }
      const sender = peer.addTrack(track, microphone);
      track.enabled = false;
      await sender.replaceTrack(null);

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);
      const offerSdp = peer.localDescription?.sdp ?? offer.sdp;
      if (!offerSdp) {
        throw new Error("webrtc_offer_missing_sdp");
      }
      const response = await this.dependencies.fetchFn(API_ROUTES.realtimeSession, {
        method: "POST",
        headers: { "content-type": "application/sdp" },
        body: offerSdp
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
      const sessionReady = this.waitForSessionReady();
      void sessionReady.catch(() => undefined);
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      await sessionReady;
      await sender.replaceTrack(track);
      track.enabled = true;
      this.setStatus("ready");
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("realtime_connection_failed");
      for (const channel of this.channels) {
        channel.close();
      }
      this.peer?.close();
      for (const track of this.microphone?.getTracks() ?? []) {
        track.stop();
      }
      this.channel = undefined;
      this.channels.clear();
      this.peer = undefined;
      this.microphone = undefined;
      this.sessionConfig = undefined;
      this.sessionUpdateSent = false;
      this.restoreSessionAfterResponse = false;
      this.rejectSessionReady(normalized);
      this.setStatus("error");
      this.callbacks.onError?.(normalized);
      throw normalized;
    }
  }

  private attachRealtimeChannel(channel: RTCDataChannel): void {
    if (this.channels.has(channel)) {
      return;
    }
    this.channels.add(channel);
    channel.addEventListener("message", (event) => {
      void this.handleServerMessage(String(event.data), channel);
    });
    channel.addEventListener("close", () => {
      this.channels.delete(channel);
      if (this.channel === channel) {
        this.channel = [...this.channels].find((candidate) => candidate.readyState === "open");
      }
      if (this.channels.size === 0 && this.status !== "idle") {
        this.setStatus("idle");
      }
    });
  }

  private async handleServerMessage(payload: string, sourceChannel: RTCDataChannel): Promise<void> {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const type = getEventType(event);
    if (type === "session.created" && !this.sessionUpdateSent && this.sessionConfig) {
      this.channel = sourceChannel;
      this.sessionUpdateSent = true;
      sourceChannel.send(JSON.stringify({
        event_id: createEventId("session"),
        type: "session.update",
        session: this.sessionConfig
      }));
    } else if (type === "session.updated" && this.sessionUpdateSent) {
      this.channel = sourceChannel;
      this.resolveSessionReady();
    }
    if (type === "input_audio_buffer.speech_started") {
      this.setStatus("listening");
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.setStatus("thinking");
    } else if (type === "response.created") {
      this.setStatus("thinking");
    } else if (type === "response.audio_transcript.delta" || type === "response.audio.delta") {
      this.setStatus("speaking");
    } else if (type === "response.audio.done") {
      this.setStatus("ready");
    } else if (type === "error") {
      const message = getRealtimeErrorMessage(event);
      const error = new Error(message);
      this.rejectSessionReady(error);
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
    } else if (type === "response.done") {
      if (this.restoreSessionAfterResponse && this.sessionConfig) {
        this.restoreSessionAfterResponse = false;
        this.sendEvent({
          event_id: createEventId("restore"),
          type: "session.update",
          session: this.sessionConfig
        });
      }
      if (this.status !== "speaking") {
        this.setStatus("ready");
      }
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

  private waitForSessionReady(): Promise<void> {
    if (this.sessionReadyTimer !== undefined) {
      globalThis.clearTimeout(this.sessionReadyTimer);
    }
    return new Promise((resolve, reject) => {
      this.sessionReadyResolve = resolve;
      this.sessionReadyReject = reject;
      this.sessionReadyTimer = globalThis.setTimeout(() => {
        this.rejectSessionReady(new Error("dashscope_realtime_session_timeout"));
      }, 20_000);
    });
  }

  private resolveSessionReady(): void {
    if (this.sessionReadyTimer !== undefined) {
      globalThis.clearTimeout(this.sessionReadyTimer);
      this.sessionReadyTimer = undefined;
    }
    const resolve = this.sessionReadyResolve;
    this.sessionReadyResolve = undefined;
    this.sessionReadyReject = undefined;
    resolve?.();
  }

  private rejectSessionReady(error: Error): void {
    if (this.sessionReadyTimer !== undefined) {
      globalThis.clearTimeout(this.sessionReadyTimer);
      this.sessionReadyTimer = undefined;
    }
    const reject = this.sessionReadyReject;
    this.sessionReadyResolve = undefined;
    this.sessionReadyReject = undefined;
    reject?.(error);
  }
}

function waitForIceGatheringComplete(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("webrtc_ice_gathering_timeout"));
    }, 10_000);
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
    };
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function createEventId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${randomId}`;
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
