import type { ChatMessage } from "@musicgpt/shared";

export type ChatStreamFailureKind = "stopped" | "error";

export interface ChatStreamFeedback {
  kind: ChatStreamFailureKind;
  retryMessage: string;
  hadPartialReply: boolean;
}

interface ChatStreamFailure {
  kind: ChatStreamFailureKind;
  streamAt: string;
  retryMessage: string;
}

export function settleChatStreamFailure(
  messages: ChatMessage[],
  failure: ChatStreamFailure
): { messages: ChatMessage[]; feedback: ChatStreamFeedback } {
  const streamingMessage = messages.find((message) => message.at === failure.streamAt);
  const hadPartialReply = Boolean(streamingMessage?.text.trim());

  return {
    messages: hadPartialReply
      ? messages
      : messages.filter((message) => message.at !== failure.streamAt),
    feedback: {
      kind: failure.kind,
      retryMessage: failure.retryMessage,
      hadPartialReply
    }
  };
}
