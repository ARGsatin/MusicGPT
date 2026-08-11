export type VoiceProtocolEvent =
  | { type: "user_preview"; itemId: string; text: string }
  | { type: "user_final"; itemId: string; transcript: string }
  | { type: "user_failed"; itemId: string }
  | { type: "assistant_delta"; responseId: string; text: string }
  | { type: "assistant_done"; responseId: string; transcript: string }
  | { type: "music_command"; callId: string; request: string; confirmationToken?: string; selectedTrackId?: number }
  | { type: "wait"; callId: string }
  | { type: "response_done"; responseId: string; status: string; transcript?: string }
  | { type: "error"; message: string };

export function parseVoiceProtocolEvents(value: unknown): VoiceProtocolEvent[] {
  if (!value || typeof value !== "object") return [];
  const event = value as Record<string, unknown>;
  const type = stringValue(event.type);
  const itemId = stringValue(event.item_id) ?? stringValue(event.itemId) ?? "unknown";
  const responseId = stringValue(event.response_id) ?? responseIdFrom(event.response) ?? "unknown";

  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = `${stringValue(event.text) ?? stringValue(event.delta) ?? ""}${stringValue(event.stash) ?? ""}`;
    return text ? [{ type: "user_preview", itemId, text }] : [];
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const transcript = stringValue(event.transcript) ?? stringValue(event.text) ?? "";
    return transcript.trim() ? [{ type: "user_final", itemId, transcript: transcript.trim() }] : [];
  }
  if (type === "conversation.item.input_audio_transcription.failed") {
    return [{ type: "user_failed", itemId }];
  }
  if (type === "response.audio_transcript.delta") {
    const text = stringValue(event.delta) ?? stringValue(event.text) ?? "";
    return text ? [{ type: "assistant_delta", responseId, text }] : [];
  }
  if (type === "response.audio_transcript.done") {
    const transcript = stringValue(event.transcript) ?? stringValue(event.text) ?? "";
    return transcript.trim()
      ? [{ type: "assistant_done", responseId, transcript: transcript.trim() }]
      : [];
  }
  if (type === "response.function_call_arguments.done") {
    return parseFunctionCall(event);
  }
  if (type === "error") {
    return [{ type: "error", message: errorMessage(event) }];
  }
  if (type !== "response.done") return [];

  const response = objectValue(event.response);
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = output.flatMap((item) => parseFunctionCall(objectValue(item)));
  const transcript = extractAssistantTranscript(output);
  if (calls.length > 0 && !transcript) return calls;
  return [
    ...calls,
    {
      type: "response_done",
      responseId,
      status: stringValue(response?.status) ?? "completed",
      ...(transcript ? { transcript } : {})
    }
  ];
}

function parseFunctionCall(event: Record<string, unknown> | undefined): VoiceProtocolEvent[] {
  if (!event) return [];
  const kind = stringValue(event.type);
  if (kind !== "function_call" && kind !== "response.function_call_arguments.done") return [];
  const name = stringValue(event.name);
  const callId = stringValue(event.call_id);
  if (!callId) return [];
  if (name === "wait_for_user") return [{ type: "wait", callId }];
  if (name !== "run_music_command") return [];
  const args = parseArguments(event.arguments);
  const request = stringValue(args?.request)?.trim();
  if (!request) return [];
  const confirmationToken = stringValue(args?.confirmationToken);
  const selectedTrackId = numberValue(args?.selectedTrackId);
  return [{
    type: "music_command",
    callId,
    request,
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(selectedTrackId !== undefined ? { selectedTrackId } : {})
  }];
}

function extractAssistantTranscript(output: unknown[]): string | undefined {
  const fragments: string[] = [];
  for (const rawItem of output) {
    const item = objectValue(rawItem);
    if (!item || stringValue(item.type) === "function_call") continue;
    const direct = stringValue(item.transcript) ?? stringValue(item.text);
    if (direct) fragments.push(direct);
    const content = Array.isArray(item.content) ? item.content : [];
    for (const rawContent of content) {
      const part = objectValue(rawContent);
      const text = stringValue(part?.transcript) ?? stringValue(part?.text);
      if (text) fragments.push(text);
    }
  }
  const transcript = fragments.join("").trim();
  return transcript || undefined;
}

function responseIdFrom(value: unknown): string | undefined {
  return stringValue(objectValue(value)?.id);
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return objectValue(value);
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(event: Record<string, unknown>): string {
  return stringValue(objectValue(event.error)?.message) ?? stringValue(event.message) ?? "realtime_protocol_error";
}
