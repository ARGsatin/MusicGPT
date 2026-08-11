import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, RefObject } from "react";

import type {
  ChatMemory,
  ChatMessage,
  DjSettings,
  RadioPlanItem
} from "@musicgpt/shared";
import aiDjAvatarUrl from "../assets/ai-dj-avatar.svg";
import { ChatMemoryPanel } from "../ChatMemoryPanel";
import { ChatStreamFeedbackNotice } from "../ChatStreamFeedbackNotice";
import type { ChatStreamFeedback } from "../chatStream";
import type { RealtimeVoiceStatus } from "../realtimeVoice";
import type { StreamingTextStore } from "../streamingTextStore";

export type PanelTab = "chat" | "queue";

interface ChatPanelProps {
  activeSpeechKey: string | undefined;
  activeTab: PanelTab;
  autoSpeak: boolean;
  canReplayDj: boolean;
  chatClearing: boolean;
  chatError: string | null;
  chatLoading: boolean;
  chatStreamFeedback: ChatStreamFeedback | null;
  djSettings: DjSettings;
  failedSpeechId: number | null;
  hasTrack: boolean;
  historyEmpty: boolean;
  loadingSpeechId: number | null;
  memories: ChatMemory[];
  memoryBusyId: number | null;
  memoryClearing: boolean;
  memoryError: string | null;
  memoryOpen: boolean;
  messages: ChatMessage[];
  nowTitle: string;
  queue: RadioPlanItem[];
  queueLoadingTrackId: number | null;
  realtimeStatus: RealtimeVoiceStatus;
  realtimeStatusLabel: string;
  speechNotice: string | null;
  streamingMessageAt: string | null;
  streamingTextStore: StreamingTextStore;
  suggestionLoadingId: string | null;
  onChangeTab: (tab: PanelTab) => void;
  onChangeTone: (tone: DjSettings["tone"]) => void;
  onClearHistory: () => void;
  onClearMemories: () => void;
  onFeedbackContinue: () => void;
  onFeedbackRetry: () => void;
  onForgetMemory: (memory: ChatMemory) => void;
  onPlaySuggestion: (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => void;
  onPlayQueueTrack: (trackId: number) => void;
  onQuickPrompt: (prompt: string) => void;
  onReplayDj: () => void;
  onSpeakMessage: (message: ChatMessage) => void;
  onStopStream: () => void;
  onSubmit: (message: string) => void;
  onToggleAutoSpeak: (enabled: boolean) => void;
  onToggleRealtimeVoice: () => void;
  onToggleMemory: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

function formatArtists(artists: string[] | undefined): string {
  if (!artists || artists.length === 0) {
    return "未知艺术家";
  }
  return artists.join(" / ");
}

const StreamingMessageRow = memo(function StreamingMessageRow({
  onTextChange,
  store
}: {
  onTextChange: () => void;
  store: StreamingTextStore;
}) {
  const text = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    onTextChange();
  }, [onTextChange, text]);

  return (
    <div className="message-row assistant-row">
      <div className="dj-avatar" aria-hidden="true">
        <img alt="" src={aiDjAvatarUrl} />
      </div>
      <div className="message-bubble">
        <div className="message-copy-row">
          <p>
            {text}
            <span className="streaming-caret" aria-label="正在生成回复" />
          </p>
        </div>
      </div>
    </div>
  );
});

const MessageList = memo(function MessageList({
  activeSpeechKey,
  chatLoading,
  failedSpeechId,
  loadingSpeechId,
  messages,
  onPlaySuggestion,
  onSpeakMessage,
  streamingMessageAt,
  streamingTextStore,
  suggestionLoadingId
}: Pick<
  ChatPanelProps,
  | "activeSpeechKey"
  | "chatLoading"
  | "failedSpeechId"
  | "loadingSpeechId"
  | "messages"
  | "streamingMessageAt"
  | "streamingTextStore"
  | "suggestionLoadingId"
> & {
  onPlaySuggestion: (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => void;
  onSpeakMessage: (message: ChatMessage) => void;
}) {
  const messageThreadRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const thread = messageThreadRef.current;
      if (thread) {
        thread.scrollTop = thread.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [chatLoading, messages.length, messages.at(-1)?.text, scrollToBottom, streamingMessageAt]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    []
  );

  return (
    <div className="message-thread" ref={messageThreadRef}>
      {messages.map((message, index) => {
        const isStreaming = message.at === streamingMessageAt;
        if (isStreaming) {
          return (
            <StreamingMessageRow
              key={`${message.at}-${index}`}
              onTextChange={scrollToBottom}
              store={streamingTextStore}
            />
          );
        }
        return (
          <div
            className={message.role === "assistant" ? "message-row assistant-row" : "message-row user-row"}
            key={`${message.at}-${index}`}
          >
            {message.role === "assistant" ? (
              <div className="dj-avatar" aria-hidden="true">
                <img alt="" src={aiDjAvatarUrl} />
              </div>
            ) : null}
            <div className={message.role === "assistant" ? "message-bubble" : "message-bubble user-bubble"}>
              <div className="message-copy-row">
                <p>
                  {message.text}
                </p>
                {message.role === "assistant" && message.id ? (
                  <button
                    className={activeSpeechKey === `chat:${message.id}` ? "speech-button is-speaking" : "speech-button"}
                    type="button"
                    aria-label={
                      activeSpeechKey === `chat:${message.id}`
                        ? "停止朗读"
                        : failedSpeechId === message.id
                          ? "重试朗读"
                          : "朗读这条回复"
                    }
                    aria-pressed={activeSpeechKey === `chat:${message.id}`}
                    onClick={() => onSpeakMessage(message)}
                    disabled={loadingSpeechId === message.id}
                  >
                    {loadingSpeechId === message.id
                      ? "…"
                      : activeSpeechKey === `chat:${message.id}`
                        ? "■"
                        : failedSpeechId === message.id
                          ? "↻"
                          : "▶"}
                  </button>
                ) : null}
              </div>
              {message.source === "voice" ? (
                <span className="message-voice-meta">
                  <span aria-hidden="true">🎙</span>
                  语音{message.status === "interrupted" ? " · 已打断" : ""}
                </span>
              ) : null}
              {message.role === "assistant" && message.trackSuggestion ? (
                <button
                  className="track-suggestion"
                  type="button"
                  onClick={() => onPlaySuggestion(message.trackSuggestion!)}
                  disabled={Boolean(suggestionLoadingId)}
                >
                  <span className="suggestion-cover" aria-hidden="true">
                    {message.trackSuggestion.track.coverUrl ? (
                      <img alt="" src={message.trackSuggestion.track.coverUrl} />
                    ) : (
                      "♪"
                    )}
                  </span>
                  <span className="suggestion-copy">
                    <strong>{message.trackSuggestion.track.title}</strong>
                    <em>{formatArtists(message.trackSuggestion.track.artists)}</em>
                    <small>{message.trackSuggestion.reason}</small>
                  </span>
                  <span className="suggestion-action">
                    {suggestionLoadingId === message.trackSuggestion.id ? "切换中" : "切到这首"}
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const QueueRail = memo(function QueueRail({
  loadingTrackId,
  onPlayTrack,
  queue
}: {
  loadingTrackId: number | null;
  onPlayTrack: (trackId: number) => void;
  queue: RadioPlanItem[];
}) {
  if (queue.length === 0) {
    return (
      <div className="queue-empty">
        <span aria-hidden="true">📻</span>
        <strong>信号整理中</strong>
        <p>电台会在下一次请求时自动补满播放窗口。</p>
      </div>
    );
  }
  return (
    <ol className="queue-rail">
      {queue.slice(0, 10).map((item, index) => {
        const loading = loadingTrackId === item.track.id;
        return (
          <li key={item.track.id}>
            <button
              aria-label={`立即播放 ${item.track.title}`}
              className={item.bucket === "explore" ? "queue-card is-explore" : "queue-card"}
              disabled={loadingTrackId !== null}
              onClick={() => onPlayTrack(item.track.id)}
              type="button"
            >
              <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="queue-cover" aria-hidden="true">
                {item.track.coverUrl ? <img alt="" src={item.track.coverUrl} /> : "♪"}
              </span>
              <span className="queue-copy">
                <strong>{item.track.title}</strong>
                <em>{formatArtists(item.track.artists)}</em>
              </span>
              <span className="queue-bucket">
                {loading ? "切换中" : item.bucket === "explore" ? "探索" : "口味"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
});

export const ChatPanel = memo(function ChatPanel(props: ChatPanelProps) {
  const {
    activeTab,
    autoSpeak,
    canReplayDj,
    chatClearing,
    chatError,
    chatLoading,
    chatStreamFeedback,
    djSettings,
    hasTrack,
    historyEmpty,
    memories,
    memoryOpen,
    messages,
    nowTitle,
    queue,
    realtimeStatus,
    realtimeStatusLabel,
    speechNotice,
    onChangeTab,
    onChangeTone,
    onClearHistory,
    onQuickPrompt,
    onReplayDj,
    onStopStream,
    onSubmit,
    onToggleAutoSpeak,
    onToggleRealtimeVoice,
    onToggleMemory,
    inputRef
  } = props;
  const [input, setInput] = useState("");

  const onSubmitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = input.trim();
    if (!message) {
      return;
    }
    setInput("");
    onSubmit(message);
  };

  return (
    <aside className="chat-panel" aria-label="DJ 电台侧栏">
      <header className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="侧栏视图">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "chat"}
            className={activeTab === "chat" ? "panel-tab is-active" : "panel-tab"}
            onClick={() => onChangeTab("chat")}
          >
            对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "queue"}
            className={activeTab === "queue" ? "panel-tab is-active" : "panel-tab"}
            onClick={() => onChangeTab("queue")}
          >
            队列 <i>{queue.length}</i>
          </button>
        </div>
        {activeTab === "chat" ? (
          <div className="panel-tools">
            <select
              value={djSettings.tone}
              onChange={(event) => onChangeTone(event.currentTarget.value as DjSettings["tone"])}
              aria-label="DJ tone"
            >
              <option value="lively">活泼</option>
              <option value="calm">温和</option>
              <option value="professional">专业</option>
            </select>
            <label className="speech-toggle">
              <input
                type="checkbox"
                checked={autoSpeak}
                onChange={(event) => onToggleAutoSpeak(event.currentTarget.checked)}
                disabled={realtimeStatus !== "ready" && realtimeStatus !== "listening" && realtimeStatus !== "speaking"}
              />
              朗读文字回复
            </label>
            <button
              className={realtimeStatus === "idle" || realtimeStatus === "error"
                ? "realtime-voice-button"
                : "realtime-voice-button is-active"}
              type="button"
              aria-pressed={realtimeStatus !== "idle" && realtimeStatus !== "error"}
              onClick={onToggleRealtimeVoice}
              disabled={realtimeStatus === "connecting"}
            >
              {realtimeStatusLabel}
            </button>
            <button
              className={memoryOpen ? "memory-toggle is-open" : "memory-toggle"}
              type="button"
              aria-expanded={memoryOpen}
              onClick={onToggleMemory}
            >
              她记得的我 {memories.length}
            </button>
          </div>
        ) : null}
      </header>

      {activeTab === "chat" ? (
        <>
          <div className="chat-memory-slot" hidden={!memoryOpen}>
            <ChatMemoryPanel
              memories={props.memories}
              busyMemoryId={props.memoryBusyId}
              clearing={props.memoryClearing}
              error={props.memoryError}
              onForget={props.onForgetMemory}
              onClear={props.onClearMemories}
            />
          </div>

          <MessageList
            activeSpeechKey={props.activeSpeechKey}
            chatLoading={chatLoading}
            failedSpeechId={props.failedSpeechId}
            loadingSpeechId={props.loadingSpeechId}
            messages={messages}
            onPlaySuggestion={props.onPlaySuggestion}
            onSpeakMessage={props.onSpeakMessage}
            streamingMessageAt={props.streamingMessageAt}
            streamingTextStore={props.streamingTextStore}
            suggestionLoadingId={props.suggestionLoadingId}
          />

          <p className="now-caption">♪ {nowTitle}</p>

          <div className="quick-chips" aria-label="快捷操作">
            <button type="button" onClick={() => onQuickPrompt("点评当前这首")} disabled={chatLoading || !hasTrack}>
              点评当前
            </button>
            <button type="button" onClick={() => onQuickPrompt("来点适合现在氛围的歌")} disabled={chatLoading}>
              氛围点歌
            </button>
            {canReplayDj ? (
              <button type="button" onClick={onReplayDj}>
                重播播报
              </button>
            ) : null}
            <button
              className="chip-danger"
              type="button"
              onClick={onClearHistory}
              disabled={chatLoading || chatClearing || historyEmpty}
            >
              {chatClearing ? "清空中…" : "清空历史"}
            </button>
          </div>

          {chatStreamFeedback ? (
            <ChatStreamFeedbackNotice
              feedback={chatStreamFeedback}
              onContinue={props.onFeedbackContinue}
              onRetry={props.onFeedbackRetry}
            />
          ) : null}
          {chatError ? <p className="chat-error">{chatError}</p> : null}
          {speechNotice ? <p className="speech-notice">{speechNotice}</p> : null}

          <form onSubmit={onSubmitForm} className="chat-form">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="想聊什么都可以；需要点歌时直接告诉我～"
              aria-label="给电台 DJ 发消息"
              disabled={chatLoading}
            />
            {chatLoading ? (
              <button
                className="stop-chat-button"
                type="button"
                aria-label="停止生成回复"
                title="停止生成回复"
                onClick={onStopStream}
              >
                ■
              </button>
            ) : (
              <button type="submit" aria-label="发送消息">
                ➤
              </button>
            )}
          </form>
        </>
      ) : (
        <QueueRail
          loadingTrackId={props.queueLoadingTrackId}
          onPlayTrack={props.onPlayQueueTrack}
          queue={queue}
        />
      )}
    </aside>
  );
});
