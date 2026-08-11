import type { ConversationTurnStatus, VoiceTurnStartRequest } from "@musicgpt/shared";
import { API_ROUTES } from "@musicgpt/shared";

import { parseVoiceProtocolEvents, type VoiceProtocolEvent } from "./voiceProtocol";

export interface RealtimeMusicFunctionCall {
  callId: string;
  request: string;
  confirmationToken?: string;
  selectedTrackId?: number;
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
  onUserPreview?: (itemId: string, text: string) => void;
  onUserDiscarded?: (itemId: string) => void;
  onTranscriptionUnavailable?: () => void;
  onVoiceTurnStart?: (input: VoiceTurnStartRequest) => Promise<{ turnId: string }>;
  onAssistantDelta?: (turnId: string, text: string) => void;
  onVoiceTurnComplete?: (input: {
    turnId: string;
    transcript?: string;
    responseId?: string;
    status: ConversationTurnStatus;
    at: string;
  }) => Promise<void>;
  onMusicCommand?: (call: RealtimeMusicFunctionCall & { turnId: string }) => Promise<unknown>;
  onLegacyMusicCommand?: (request: string) => Promise<unknown>;
}

export interface RealtimeVoiceDependencies {
  fetchFn: typeof fetch;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
}

type RealtimeClientEvent = Record<string, unknown>;
type RealtimeSessionConfig = Record<string, unknown>;

export function normalizeAnswerSdp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return `${trimmed.replace(/\r?\n/g, "\r\n")}\r\n`;
}

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
    const args = JSON.parse(item.arguments) as {
      request?: unknown;
      confirmationToken?: unknown;
      selectedTrackId?: unknown;
    };
    return typeof args.request === "string" && args.request.trim()
      ? {
          callId: item.call_id,
          request: args.request.trim(),
          ...(typeof args.confirmationToken === "string"
            ? { confirmationToken: args.confirmationToken }
            : {}),
          ...(typeof args.selectedTrackId === "number"
            ? { selectedTrackId: args.selectedTrackId }
            : {})
        }
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
  private sessionId: string | undefined;
  private contextRevision = 0;
  private pendingUser: { itemId: string; transcript: string } | undefined;
  private activeTurn: {
    turnId: string;
    itemId: string;
    assistantText: string;
    responseId?: string;
  } | undefined;
  private narrationResponseId: string | undefined;
  private interactiveResponseId: string | undefined;
  private readonly completedResponseIds = new Set<string>();
  private legacyMode = false;

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly callbacks: RealtimeVoiceCallbacks = {},
    private readonly dependencies: RealtimeVoiceDependencies = defaultDependencies()
  ) {}

  get connected(): boolean {
    return this.channel?.readyState === "open";
  }

  isCurrentSession(sessionId: string | undefined): boolean {
    return Boolean(sessionId && sessionId === this.sessionId);
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
    this.sessionId = undefined;
    this.contextRevision = 0;
    this.pendingUser = undefined;
    this.activeTurn = undefined;
    this.narrationResponseId = undefined;
    this.interactiveResponseId = undefined;
    this.completedResponseIds.clear();
    this.legacyMode = false;
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

  setMicrophoneEnabled(enabled: boolean): void {
    for (const track of this.microphone?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  async refreshContext(): Promise<void> {
    if (!this.connected || !this.sessionId || !this.sessionConfig) return;
    const query = new URLSearchParams({
      sessionId: this.sessionId,
      baselineRevision: String(this.contextRevision)
    });
    const response = await this.dependencies.fetchFn(`${API_ROUTES.realtimeContext}?${query}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`realtime_context_failed:${response.status}`);
    const context = await response.json() as {
      instructions?: unknown;
      contextRevision?: unknown;
      session?: unknown;
    };
    if (typeof context.instructions !== "string" || typeof context.contextRevision !== "number") return;
    this.contextRevision = context.contextRevision;
    this.sessionConfig = context.session && typeof context.session === "object"
      ? context.session as RealtimeSessionConfig
      : { ...this.sessionConfig, instructions: context.instructions };
    this.sendEvent({
      event_id: createEventId("rebase"),
      type: "session.update",
      session: this.sessionConfig
    });
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
        sessionId?: unknown;
        contextRevision?: unknown;
        conversationMode?: unknown;
      };
      if (availability.enabled !== true) {
        throw new Error("dashscope_realtime_not_configured");
      }
      if (!availability.session || typeof availability.session !== "object") {
        throw new Error("dashscope_realtime_session_config_missing");
      }
      this.sessionConfig = availability.session as RealtimeSessionConfig;
      this.sessionId = typeof availability.sessionId === "string"
        ? availability.sessionId
        : createEventId("voice-session");
      this.contextRevision = typeof availability.contextRevision === "number"
        ? availability.contextRevision
        : 0;
      this.legacyMode = availability.conversationMode === "legacy";
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
      const responseBody = await response.text();
      if (!response.ok) {
        let message = `realtime_session_failed:${response.status}`;
        try {
          const payload = JSON.parse(responseBody) as { error?: unknown };
          if (typeof payload.error === "string") {
            message = payload.error;
          }
        } catch {
          // The status code remains enough context for non-JSON failures.
        }
        throw new Error(message);
      }
      const answerSdp = normalizeAnswerSdp(responseBody);
      if (!answerSdp) {
        throw new Error("realtime_answer_missing_sdp");
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
      this.pendingUser = undefined;
      this.activeTurn = undefined;
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
      void this.handleServerMessage(String(event.data), channel).catch((error) => {
        this.callbacks.onError?.(
          error instanceof Error ? error : new Error("realtime_event_handling_failed")
        );
      });
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
      await this.interruptCurrentResponse();
      this.pendingUser = undefined;
      this.setStatus("listening");
    } else if (type === "input_audio_buffer.speech_stopped") {
      this.setStatus("thinking");
    } else if (type === "response.created") {
      const responseId = getResponseId(event);
      if (this.restoreSessionAfterResponse) {
        this.narrationResponseId = responseId;
      } else {
        this.interactiveResponseId = responseId;
      }
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

    for (const protocolEvent of parseVoiceProtocolEvents(event)) {
      await this.handleProtocolEvent(protocolEvent);
    }
  }

  private async handleProtocolEvent(event: VoiceProtocolEvent): Promise<void> {
    if (this.legacyMode && event.type === "response_done" && !this.restoreSessionAfterResponse) {
      this.interactiveResponseId = undefined;
      this.setStatus("ready");
      return;
    }
    if (this.legacyMode && (
      event.type === "user_preview" ||
      event.type === "user_final" ||
      event.type === "user_failed" ||
      event.type === "assistant_delta" ||
      event.type === "assistant_done"
    )) return;
    if (event.type === "user_preview") {
      this.pendingUser = { itemId: event.itemId, transcript: event.text };
      this.callbacks.onUserPreview?.(event.itemId, event.text);
      return;
    }
    if (event.type === "user_final") {
      this.pendingUser = { itemId: event.itemId, transcript: event.transcript };
      this.callbacks.onUserPreview?.(event.itemId, event.transcript);
      return;
    }
    if (event.type === "user_failed") {
      this.callbacks.onUserDiscarded?.(event.itemId);
      this.callbacks.onTranscriptionUnavailable?.();
      this.pendingUser = undefined;
      return;
    }
    if (event.type === "wait") {
      if (this.handledCallIds.has(event.callId)) return;
      this.handledCallIds.add(event.callId);
      if (this.pendingUser) this.callbacks.onUserDiscarded?.(this.pendingUser.itemId);
      this.pendingUser = undefined;
      this.sendFunctionOutput(event.callId, { ok: true, outcome: "wait" });
      return;
    }
    if (event.type === "music_command") {
      if (this.handledCallIds.has(event.callId)) return;
      this.handledCallIds.add(event.callId);
      if (this.legacyMode) {
        await this.completeMusicFunctionCall({ callId: event.callId, request: event.request });
        return;
      }
      const turn = await this.ensureActiveTurn();
      if (!turn) {
        this.sendFunctionOutput(event.callId, { ok: false, error: "input_transcription_unavailable" });
        return;
      }
      this.setStatus("thinking");
      await this.completeMusicFunctionCall({
        callId: event.callId,
        request: event.request,
        ...(event.confirmationToken ? { confirmationToken: event.confirmationToken } : {}),
        ...(event.selectedTrackId !== undefined ? { selectedTrackId: event.selectedTrackId } : {})
      }, turn.turnId);
      return;
    }
    if (event.type === "assistant_delta") {
      if (this.restoreSessionAfterResponse) return;
      const turn = await this.ensureActiveTurn();
      if (!turn) return;
      turn.responseId = event.responseId;
      turn.assistantText += event.text;
      this.callbacks.onAssistantDelta?.(turn.turnId, event.text);
      return;
    }
    if (event.type === "assistant_done") {
      if (this.restoreSessionAfterResponse || this.completedResponseIds.has(event.responseId)) return;
      const turn = await this.ensureActiveTurn();
      if (!turn) return;
      turn.responseId = event.responseId;
      turn.assistantText = event.transcript;
      await this.completeActiveTurn("completed", event.responseId, event.transcript);
      return;
    }
    if (event.type === "response_done") {
      await this.finishResponse(event);
    }
  }

  private async ensureActiveTurn() {
    if (this.activeTurn) return this.activeTurn;
    if (!this.pendingUser || !this.sessionId || !this.callbacks.onVoiceTurnStart) {
      this.callbacks.onTranscriptionUnavailable?.();
      return undefined;
    }
    const start = await this.callbacks.onVoiceTurnStart({
      sessionId: this.sessionId,
      clientTurnId: this.pendingUser.itemId,
      transcript: this.pendingUser.transcript,
      at: new Date().toISOString()
    });
    this.activeTurn = {
      turnId: start.turnId,
      itemId: this.pendingUser.itemId,
      assistantText: ""
    };
    return this.activeTurn;
  }

  private async finishResponse(event: Extract<VoiceProtocolEvent, { type: "response_done" }>): Promise<void> {
    const isNarration = this.restoreSessionAfterResponse &&
      (!this.narrationResponseId || event.responseId === this.narrationResponseId);
    if (isNarration) {
      this.restoreSessionAfterResponse = false;
      this.narrationResponseId = undefined;
      await this.rebuildAfterNarration();
      return;
    }
    if (this.completedResponseIds.has(event.responseId)) {
      if (this.interactiveResponseId === event.responseId) this.interactiveResponseId = undefined;
      return;
    }
    if (this.interactiveResponseId && event.responseId !== "unknown" &&
      event.responseId !== this.interactiveResponseId) return;
    const turn = await this.ensureActiveTurn();
    if (turn) {
      const transcript = event.transcript ?? turn.assistantText.trim();
      await this.completeActiveTurn(transcript ? "completed" : "failed", event.responseId, transcript || undefined);
    }
    this.interactiveResponseId = undefined;
    this.setStatus("ready");
  }

  private async interruptCurrentResponse(): Promise<void> {
    if (this.restoreSessionAfterResponse) {
      this.sendEvent({ type: "response.cancel" });
      if (this.narrationResponseId) this.completedResponseIds.add(this.narrationResponseId);
      this.restoreSessionAfterResponse = false;
      this.narrationResponseId = undefined;
      await this.rebuildAfterNarration();
      return;
    }
    if (this.activeTurn?.assistantText.trim()) {
      await this.completeActiveTurn(
        "interrupted",
        this.activeTurn.responseId ?? this.interactiveResponseId,
        this.activeTurn.assistantText.trim()
      );
    }
  }

  private async rebuildAfterNarration(): Promise<void> {
    this.stop();
    try {
      await this.start();
    } catch {
      // start() already reports a user-facing error and leaves text chat available.
    }
  }

  private async completeActiveTurn(
    status: ConversationTurnStatus,
    responseId?: string,
    transcript?: string
  ): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;
    if (responseId && responseId !== "unknown") this.completedResponseIds.add(responseId);
    if (this.callbacks.onVoiceTurnComplete) {
      await this.callbacks.onVoiceTurnComplete({
        turnId: turn.turnId,
        status,
        at: new Date().toISOString(),
        ...(transcript ? { transcript } : {}),
        ...(responseId && responseId !== "unknown" ? { responseId } : {})
      });
    }
    this.pendingUser = undefined;
    this.activeTurn = undefined;
  }

  private async completeMusicFunctionCall(call: RealtimeMusicFunctionCall, turnId?: string): Promise<void> {
    let output: unknown;
    try {
      if (this.legacyMode) {
        if (!this.callbacks.onLegacyMusicCommand) throw new Error("legacy_music_command_handler_unavailable");
        output = { ok: true, result: await this.callbacks.onLegacyMusicCommand(call.request) };
      } else {
        if (!this.callbacks.onMusicCommand || !turnId) {
          throw new Error("music_command_handler_unavailable");
        }
        output = { ok: true, result: await this.callbacks.onMusicCommand({ ...call, turnId }) };
      }
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : "music_command_failed"
      };
    }
    this.sendFunctionOutput(call.callId, output);
    this.sendEvent({ type: "response.create" });
  }

  private sendFunctionOutput(callId: string, output: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    });
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

function getResponseId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const response = (event as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
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
