import type { ChatStreamFeedback } from "./chatStream";

interface ChatStreamFeedbackNoticeProps {
  feedback: ChatStreamFeedback;
  onContinue: () => void;
  onRetry: () => void;
}

export function ChatStreamFeedbackNotice({
  feedback,
  onContinue,
  onRetry
}: ChatStreamFeedbackNoticeProps) {
  const isStopped = feedback.kind === "stopped";
  const detail = feedback.hadPartialReply
    ? "已保留收到的回复。"
    : "还没收到回复内容。";

  return (
    <div
      className={`chat-stream-feedback is-${feedback.kind}`}
      role="status"
      aria-live="polite"
    >
      <div>
        <strong>{isStopped ? "已停止" : "出错"}</strong>
        <span>
          {isStopped ? detail : `连接中断，${detail}`}
        </span>
      </div>
      <div className="chat-stream-feedback-actions">
        {!isStopped ? (
          <button type="button" onClick={onRetry}>
            重试
          </button>
        ) : null}
        <button type="button" onClick={onContinue}>
          继续聊天
        </button>
      </div>
    </div>
  );
}
