import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMemory,
  ChatMessage,
  ChatStreamEvent,
  DjSettings,
  EnvironmentContext,
  NowPlayingState,
  RadioPlanItem,
  SystemStatus,
  TasteProfile,
  TrackReference,
  WsPayload
} from "@musicgpt/shared";
import {
  clearChatMemories,
  clearChatHistory,
  completeVoiceTurn,
  deleteChatMemory,
  fetchDjSettings,
  fetchEnvironment,
  fetchChatMemories,
  fetchChatHistory,
  fetchNowPlaying,
  fetchSystemStatus,
  fetchTaste,
  importRecommendations,
  importFromNcm,
  playSuggestedTrack,
  playQueuedTrack,
  requestNext,
  reportRealtimeError,
  runMusicCommand,
  setFavorite as updateFavorite,
  sendChat,
  sendChatStream,
  sendFeedback,
  updateDjSettings,
  updateEnvironmentLocation,
  startVoiceTurn
} from "./api";
import { AmbientBackdrop } from "./components/AmbientBackdrop";
import { ChatPanel, type PanelTab } from "./components/ChatPanel";
import { DailyPlanPanel } from "./components/DailyPlanPanel";
import { SignalTicker, StatusRibbon } from "./components/StatusRibbon";
import { TurntableStage } from "./components/TurntableStage";
import { settleChatStreamFailure, type ChatStreamFeedback } from "./chatStream";
import { createStreamingTextStore } from "./streamingTextStore";
import {
  RealtimeVoiceController,
  type RealtimeVoiceStatus
} from "./realtimeVoice";
import { useWsStream } from "./useWsStream";
import { loadAutoSpeak, saveAutoSpeak } from "./speech";

const DEFAULT_DJ_SETTINGS: DjSettings = {
  tone: "lively",
  voiceGender: "female",
  voice: "Tina"
};

const REALTIME_STATUS_LABELS: Record<RealtimeVoiceStatus, string> = {
  idle: "开启实时语音",
  connecting: "连接中…",
  ready: "实时语音已连接",
  listening: "正在听你说",
  thinking: "正在想",
  speaking: "正在说",
  error: "重新连接语音"
};

interface ActiveChatStream {
  abortController: AbortController;
  receivedText: string;
  retryMessage: string;
  streamAt: string;
  token: number;
}

function materializeStreamingText(messages: ChatMessage[], stream: ActiveChatStream): ChatMessage[] {
  return messages.map((message) =>
    message.at === stream.streamAt ? { ...message, text: stream.receivedText } : message
  );
}

function getBrowserStorage(): Storage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return "未导入";
  }
  return new Date(value).toLocaleString("zh-CN");
}

function formatWeather(environment: EnvironmentContext | null): string {
  if (!environment) {
    return "天气 --";
  }
  const labels: Record<EnvironmentContext["weather"], string> = {
    clear: "晴",
    cloudy: "多云",
    rain: "雨",
    snow: "雪",
    fog: "雾",
    storm: "风暴",
    unknown: "天气 --"
  };
  const temp = typeof environment.temperature === "number" ? ` ${environment.temperature}°C` : "";
  return `${labels[environment.weather]}${temp}`;
}

const PERIOD_LABELS: Record<string, string> = {
  morning: "清晨",
  afternoon: "午后",
  evening: "傍晚",
  late_night: "深夜"
};

type MobileView = "stage" | "panel";

export default function App() {
  const [now, setNow] = useState<NowPlayingState>({ queue: [], paused: false });
  const [taste, setTaste] = useState<TasteProfile | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentContext | null>(null);
  const [djSettings, setDjSettings] = useState<DjSettings>(DEFAULT_DJ_SETTINGS);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [voicePreview, setVoicePreview] = useState<ChatMessage | null>(null);
  const [voiceAssistantDraft, setVoiceAssistantDraft] = useState<ChatMessage | null>(null);
  const [chatMemories, setChatMemories] = useState<ChatMemory[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [busyMemoryId, setBusyMemoryId] = useState<number | null>(null);
  const [memoryClearing, setMemoryClearing] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatStreamFeedback, setChatStreamFeedback] = useState<ChatStreamFeedback | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatClearing, setChatClearing] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(() => loadAutoSpeak(getBrowserStorage()));
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeVoiceStatus>("idle");
  const [speechActive, setSpeechActive] = useState(false);
  const [activeSpeechKey, setActiveSpeechKey] = useState<string | undefined>(undefined);
  const [loadingSpeechId, setLoadingSpeechId] = useState<number | null>(null);
  const [failedSpeechId, setFailedSpeechId] = useState<number | null>(null);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [streamingMessageAt, setStreamingMessageAt] = useState<string | null>(null);
  const [suggestionLoadingId, setSuggestionLoadingId] = useState<string | null>(null);
  const [queueLoadingTrackId, setQueueLoadingTrackId] = useState<TrackReference | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [v15Error, setV15Error] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("chat");
  const [mobileView, setMobileView] = useState<MobileView>("stage");
  const currentTrackRef = useRef<NowPlayingState["track"]>(undefined);
  const advanceInFlightRef = useRef(false);
  const speechAudioRef = useRef<HTMLAudioElement>(null);
  const realtimeVoiceRef = useRef<RealtimeVoiceController | null>(null);
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const chatStreamTokenRef = useRef(0);
  const activeChatStreamRef = useRef<ActiveChatStream | null>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const autoSpeakRef = useRef(autoSpeak);
  const [streamingTextStore] = useState(createStreamingTextStore);

  const refresh = useCallback(async () => {
    const [
      nowState,
      tasteProfile,
      status,
      chatHistory,
      memories,
      environmentContext,
      settings
    ] = await Promise.all([
      fetchNowPlaying(),
      fetchTaste(),
      fetchSystemStatus(),
      fetchChatHistory().catch(() => []),
      fetchChatMemories().catch(() => []),
      fetchEnvironment().catch(() => null),
      fetchDjSettings().catch(() => DEFAULT_DJ_SETTINGS)
    ]);
    setNow(nowState);
    setTaste(tasteProfile);
    setSystemStatus(status);
    setMessages(chatHistory);
    setChatMemories(memories);
    setEnvironment(environmentContext);
    setDjSettings(settings);
  }, []);

  const refreshTaste = useCallback(async () => {
    setTaste(await fetchTaste());
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    currentTrackRef.current = now.track;
  }, [now.track]);

  useEffect(() => {
    const audio = speechAudioRef.current;
    if (!audio) {
      return;
    }
    const controller = new RealtimeVoiceController(audio, {
      onStatusChange: (status) => {
        setRealtimeStatus(status);
        setSpeechActive(status === "listening" || status === "speaking");
        if (status === "ready" || status === "idle" || status === "error") {
          setActiveSpeechKey(undefined);
        }
      },
      onError: (error) => {
        void reportRealtimeError(error.message).catch(() => undefined);
        const notice = error.message === "dashscope_realtime_not_configured"
          ? "实时语音需要在服务端配置 DASHSCOPE_API_KEY。"
          : error.message === "dashscope_realtime_endpoint_not_configured"
            ? "实时语音需要配置 DASHSCOPE_WORKSPACE_ID 或完整的 DASHSCOPE_REALTIME_BASE_URL。"
          : error.message.includes("Permission") || error.message.includes("permission")
            ? "没有拿到麦克风权限；请允许访问后再试。"
            : error.message.includes("Voice turn") || error.message.includes("Music command")
              ? "实时语音仍可继续，但这轮没有同步到统一历史；稍后可以重试。"
            : "实时语音连接失败，文字聊天仍可继续。";
        setSpeechNotice(notice);
      },
      onUserPreview: (itemId, text) => {
        setVoicePreview({
          role: "user",
          text,
          at: `voice-preview:${itemId}`,
          source: "voice",
          status: "completed"
        });
      },
      onUserDiscarded: (itemId) => {
        setVoicePreview((current) => current?.at === `voice-preview:${itemId}` ? null : current);
      },
      onTranscriptionUnavailable: () => {
        setSpeechNotice("这次语音没有拿到可靠转写，未写入会话历史；可以继续说或重新连接。 ");
      },
      onVoiceTurnStart: async (input) => {
        const response = await startVoiceTurn(input);
        setVoicePreview(null);
        setMessages(response.messages);
        return { turnId: response.turnId };
      },
      onAssistantDelta: (turnId, delta) => {
        setVoiceAssistantDraft((current) => current?.turnId === turnId
          ? { ...current, text: current.text + delta }
          : {
              role: "assistant",
              text: delta,
              at: `voice-assistant:${turnId}`,
              turnId,
              source: "voice",
              status: "completed"
            });
      },
      onVoiceTurnComplete: async ({ turnId, transcript, responseId, status, at }) => {
        const nextMessages = await completeVoiceTurn(turnId, {
          model: "qwen3.5-omni-plus-realtime",
          status,
          at,
          ...(transcript ? { transcript } : {}),
          ...(responseId ? { responseId } : {})
        });
        setVoiceAssistantDraft(null);
        setMessages(nextMessages);
      },
      onMusicCommand: async (call) => {
        const response = await runMusicCommand({
          turnId: call.turnId,
          commandId: call.callId,
          request: call.request,
          mode: "voice_direct",
          ...(call.confirmationToken ? { confirmationToken: call.confirmationToken } : {}),
          ...(call.selectedTrackId !== undefined ? { selectedTrackId: call.selectedTrackId } : {})
        });
        setNow(response.now);
        await refreshTaste().catch(() => undefined);
        return {
          action: response.action,
          outcome: response.outcome,
          summary: response.summary,
          ...(response.candidates ? { candidates: response.candidates.slice(0, 3) } : {}),
          ...(response.confirmationToken ? { confirmationToken: response.confirmationToken } : {}),
          now: {
            paused: response.now.paused,
            track: response.now.track
              ? {
                  id: response.now.track.id,
                  title: response.now.track.title,
                  artists: response.now.track.artists
                }
              : null,
            queueLength: response.now.queue.length
          }
        };
      },
      onLegacyMusicCommand: async (request) => {
        const response = await sendChat(request);
        setMessages(response.messages);
        setNow(response.now);
        return { action: response.action, summary: response.reply, now: response.now };
      }
    });
    realtimeVoiceRef.current = controller;
    return () => {
      chatStreamAbortRef.current?.abort();
      controller.stop();
      realtimeVoiceRef.current = null;
    };
  }, [refreshTaste]);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
    saveAutoSpeak(getBrowserStorage(), autoSpeak);
  }, [autoSpeak]);

  const stopActiveChatStream = useCallback(() => {
    const activeStream = activeChatStreamRef.current;
    if (!activeStream) {
      return;
    }

    activeChatStreamRef.current = null;
    chatStreamAbortRef.current = null;
    chatStreamTokenRef.current += 1;
    activeStream.abortController.abort();
    setMessages((current) =>
      settleChatStreamFailure(materializeStreamingText(current, activeStream), {
        kind: "stopped",
        streamAt: activeStream.streamAt,
        retryMessage: activeStream.retryMessage
      }).messages
    );
    setChatStreamFeedback({
      kind: "stopped",
      retryMessage: activeStream.retryMessage,
      hadPartialReply: Boolean(activeStream.receivedText.trim())
    });
    setStreamingMessageAt(null);
    setChatLoading(false);
    realtimeVoiceRef.current?.setMicrophoneEnabled(true);
  }, []);

  const playAssistantMessage = useCallback(async (message: ChatMessage, manual = false) => {
    if (!message.id) {
      return;
    }
    const controller = realtimeVoiceRef.current;
    if (!controller) {
      return;
    }
    const key = `chat:${message.id}`;
    if (manual && activeSpeechKey === key) {
      return;
    }
    if (manual) {
      stopActiveChatStream();
    }
    setLoadingSpeechId(message.id);
    setFailedSpeechId(null);
    setSpeechNotice(null);
    setActiveSpeechKey(key);
    try {
      await controller.speakText(message.text, key);
    } catch {
      setFailedSpeechId(message.id);
      setActiveSpeechKey(undefined);
    } finally {
      setLoadingSpeechId((current) => (current === message.id ? null : current));
    }
  }, [activeSpeechKey, stopActiveChatStream]);

  const playDjScript = useCallback(async (script: NonNullable<NowPlayingState["djScript"]>, manual = false) => {
    const controller = realtimeVoiceRef.current;
    if (!controller) {
      return;
    }
    if (!manual && !controller.connected) {
      return;
    }
    setSpeechNotice(null);
    const key = `dj:${script.id}`;
    setActiveSpeechKey(key);
    try {
      await controller.speakText(script.text, key);
    } catch {
      setActiveSpeechKey(undefined);
    }
  }, []);

  const onWsPayload = useCallback(
    (payload: WsPayload) => {
      if (payload.event === "now_playing_updated") {
        setNow(payload.data as NowPlayingState);
      } else if (payload.event === "queue_updated") {
        setNow((current) => ({ ...current, queue: payload.data as NowPlayingState["queue"] }));
      } else if (payload.event === "dj_script_ready") {
        const script = payload.data as NowPlayingState["djScript"];
        setNow((current) => (script ? { ...current, djScript: script } : { ...current }));
        const voiceStatus = realtimeVoiceRef.current?.status;
        const conversationBusy = Boolean(activeChatStreamRef.current) ||
          voiceStatus === "listening" || voiceStatus === "thinking" || voiceStatus === "speaking";
        if (script && autoSpeakRef.current && !conversationBusy) {
          void playDjScript(script);
        }
      } else if (payload.event === "system_status") {
        const status = payload.data as SystemStatus;
        setSystemStatus(status);
        if (status.environment) {
          setEnvironment(status.environment);
        }
        if (status.djSettings) {
          setDjSettings(status.djSettings);
        }
      } else if (payload.event === "chat_memory_updated") {
        const data = payload.data as { memories?: ChatMemory[] };
        if (Array.isArray(data.memories)) {
          setChatMemories(data.memories);
        }
      } else if (payload.event === "conversation_updated") {
        const data = payload.data as {
          source?: "text" | "voice";
          sessionId?: string;
          messages?: ChatMessage[];
        };
        if (!(data.source === "voice" && realtimeVoiceRef.current?.isCurrentSession(data.sessionId))) {
          if (Array.isArray(data.messages)) setMessages(data.messages);
          void realtimeVoiceRef.current?.refreshContext().catch(() => undefined);
        }
      }
    },
    [playDjScript]
  );

  useWsStream(onWsPayload);

  const submitChat = async (rawMessage: string) => {
    if (chatLoading) {
      return;
    }
    if (!rawMessage.trim()) {
      return;
    }
    const message = rawMessage.trim();
    const turnId = globalThis.crypto?.randomUUID?.() ?? `text-${Date.now()}-${Math.random()}`;
    const optimistic: ChatMessage = {
      role: "user",
      text: message,
      at: new Date().toISOString(),
      turnId,
      source: "text",
      status: "completed"
    };
    const streamAt = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const streamingAssistant: ChatMessage = {
      role: "assistant",
      text: "",
      at: streamAt
    };
    const streamKey = `chat-stream:${streamAt}`;
    const streamToken = ++chatStreamTokenRef.current;
    const abortController = new AbortController();
    chatStreamAbortRef.current?.abort();
    chatStreamAbortRef.current = abortController;
    const activeStream: ActiveChatStream = {
      abortController,
      receivedText: "",
      retryMessage: message,
      streamAt,
      token: streamToken
    };
    activeChatStreamRef.current = activeStream;
    streamingTextStore.clear();
    setChatError(null);
    setChatStreamFeedback(null);
    setSpeechNotice(null);
    setChatLoading(true);
    realtimeVoiceRef.current?.setMicrophoneEnabled(false);
    setStreamingMessageAt(streamAt);
    setMessages((current) => [...current, optimistic, streamingAssistant]);
    try {
      await sendChatStream(message, {
        turnId,
        signal: abortController.signal,
        onEvent: (event: ChatStreamEvent) => {
          if (chatStreamTokenRef.current !== streamToken) {
            return;
          }
          if (event.type === "text_delta") {
            activeStream.receivedText += event.delta;
            streamingTextStore.append(event.delta);
          } else if (event.type === "result") {
            if (activeChatStreamRef.current?.token === streamToken) {
              activeChatStreamRef.current = null;
            }
            setMessages(event.response.messages);
            setNow(event.response.now);
            setStreamingMessageAt(null);
            realtimeVoiceRef.current?.setMicrophoneEnabled(true);
            if (autoSpeakRef.current && realtimeVoiceRef.current?.connected) {
              setActiveSpeechKey(streamKey);
              void realtimeVoiceRef.current.speakText(event.response.reply, streamKey).catch(() => {
                setActiveSpeechKey(undefined);
              });
            }
          }
        }
      });
      await refreshTaste().catch(() => undefined);
    } catch {
      if (!abortController.signal.aborted && chatStreamTokenRef.current === streamToken) {
        setMessages((current) =>
          settleChatStreamFailure(materializeStreamingText(current, activeStream), {
            kind: "error",
            streamAt,
            retryMessage: message
          }).messages
        );
        setChatStreamFeedback({
          kind: "error",
          retryMessage: message,
          hadPartialReply: Boolean(activeStream.receivedText.trim())
        });
      }
    } finally {
      if (chatStreamAbortRef.current === abortController) {
        chatStreamAbortRef.current = null;
      }
      if (chatStreamTokenRef.current === streamToken) {
        if (activeChatStreamRef.current?.token === streamToken) {
          activeChatStreamRef.current = null;
        }
        setStreamingMessageAt(null);
        setChatLoading(false);
        realtimeVoiceRef.current?.setMicrophoneEnabled(true);
      }
    }
  };

  const onPlaySuggestion = useCallback(
    async (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => {
      if (suggestionLoadingId) {
        return;
      }
      setSuggestionLoadingId(suggestion.id);
      setChatError(null);
      try {
        const response = await playSuggestedTrack(suggestion.track, suggestion.reason);
        setNow(response.now);
        await refreshTaste();
      } catch (error) {
        setChatError(error instanceof Error ? error.message : "这首歌暂时切不过去。");
      } finally {
        setSuggestionLoadingId(null);
      }
    },
    [refreshTaste, suggestionLoadingId]
  );

  const onClearChatHistory = async () => {
    if (chatLoading || chatClearing || messages.length === 0) {
      return;
    }
    const confirmed = window.confirm(
      "确定清空全部聊天记录吗？此操作无法撤销，但“她记得的我”中的长期记忆会保留。"
    );
    if (!confirmed) {
      return;
    }

    setChatClearing(true);
    setChatError(null);
    try {
      await clearChatHistory();
      setMessages([]);
      setVoicePreview(null);
      setVoiceAssistantDraft(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "聊天记录清空失败，请稍后再试。");
    } finally {
      setChatClearing(false);
    }
  };

  const onForgetMemory = async (memory: ChatMemory) => {
    if (busyMemoryId !== null || memoryClearing) {
      return;
    }
    setBusyMemoryId(memory.id);
    setMemoryError(null);
    try {
      await deleteChatMemory(memory.id);
      setChatMemories((current) => current.filter((item) => item.id !== memory.id));
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "这条记忆暂时忘不掉，请稍后再试。");
    } finally {
      setBusyMemoryId(null);
    }
  };

  const onClearMemories = async () => {
    if (memoryClearing || busyMemoryId !== null || chatMemories.length === 0) {
      return;
    }
    const confirmed = window.confirm("确定让她忘记全部长期记忆吗？聊天记录会继续保留。");
    if (!confirmed) {
      return;
    }
    setMemoryClearing(true);
    setMemoryError(null);
    try {
      await clearChatMemories();
      setChatMemories([]);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "长期记忆清空失败，请稍后再试。");
    } finally {
      setMemoryClearing(false);
    }
  };

  const runWithAdvanceLock = useCallback(async (job: () => Promise<void>) => {
    if (advanceInFlightRef.current) {
      return;
    }
    advanceInFlightRef.current = true;
    try {
      await job();
    } finally {
      advanceInFlightRef.current = false;
    }
  }, []);

  const onPlayQueueTrack = useCallback(
    async (trackId: RadioPlanItem["track"]["id"]) => {
      if (queueLoadingTrackId !== null) {
        return;
      }
      setQueueLoadingTrackId(trackId);
      setChatError(null);
      try {
        await runWithAdvanceLock(async () => {
          const response = await playQueuedTrack(trackId);
          setNow(response.now);
          await refreshTaste();
        });
      } catch (error) {
        setChatError(error instanceof Error ? error.message : "这首歌暂时切不过去。");
      } finally {
        setQueueLoadingTrackId(null);
      }
    },
    [queueLoadingTrackId, refreshTaste, runWithAdvanceLock]
  );

  const onRequestNext = useCallback(
    async (recordSkip = false) => {
      await runWithAdvanceLock(async () => {
        const currentTrack = currentTrackRef.current;
        if (recordSkip && currentTrack) {
          await sendFeedback({ type: "skip", trackId: currentTrack.id });
        }
        const response = await requestNext();
        setNow(response.now);
        await refreshTaste();
      });
    },
    [refreshTaste, runWithAdvanceLock]
  );

  const onTrackEnded = useCallback(async () => {
    await runWithAdvanceLock(async () => {
      const currentTrack = currentTrackRef.current;
      if (!currentTrack) {
        return;
      }
      await sendFeedback({ type: "complete", trackId: currentTrack.id });
      const response = await requestNext();
      setNow(response.now);
      await refreshTaste();
    });
  }, [refreshTaste, runWithAdvanceLock]);

  const onFeedback = useCallback(
    async (type: "skip" | "like" | "replay" | "complete") => {
      const currentTrack = currentTrackRef.current;
      if (!currentTrack) {
        return;
      }
      await sendFeedback({ type, trackId: currentTrack.id });
      if (type === "skip") {
        await onRequestNext();
        return;
      }
      await refreshTaste();
    },
    [onRequestNext, refreshTaste]
  );

  const onFavorite = useCallback(async (favorite: boolean) => {
    const currentTrack = currentTrackRef.current;
    if (!currentTrack) {
      return;
    }
    const result = await updateFavorite(currentTrack.id, favorite);
    setNow((current) =>
      current.track?.id === currentTrack.id ? { ...current, isFavorite: result.favorite } : current
    );
    setTaste(result.taste);
  }, []);

  const onPlaybackStateChange = useCallback((paused: boolean) => {
    setNow((current) => (current.paused === paused ? current : { ...current, paused }));
  }, []);

  const onImportNcm = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const result = await importFromNcm();
      setSystemStatus(result.systemStatus);
      await refresh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败，请检查 NCM API 和 Cookie。");
    } finally {
      setImporting(false);
    }
  };

  const onSyncWeather = async () => {
    setWeatherLoading(true);
    setV15Error(null);
    try {
      if (!navigator.geolocation) {
        throw new Error("当前浏览器不支持定位。");
      }
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          maximumAge: 10 * 60 * 1000,
          timeout: 8000
        });
      });
      const context = await updateEnvironmentLocation({
        latitude: Number(position.coords.latitude.toFixed(4)),
        longitude: Number(position.coords.longitude.toFixed(4))
      });
      setEnvironment(context);
      await refresh();
    } catch (error) {
      setV15Error(error instanceof Error ? error.message : "天气定位失败，已保留时间推荐。");
    } finally {
      setWeatherLoading(false);
    }
  };

  const onImportRecommendations = async () => {
    setRecommendationLoading(true);
    setV15Error(null);
    try {
      const result = await importRecommendations();
      setEnvironment(result.environment);
      setSystemStatus(result.systemStatus);
      await refresh();
    } catch (error) {
      setV15Error(error instanceof Error ? error.message : "推荐扩充失败，请稍后再试。");
    } finally {
      setRecommendationLoading(false);
    }
  };

  const onChangeDjTone = async (tone: DjSettings["tone"]) => {
    const nextSettings = { ...djSettings, tone };
    setDjSettings(nextSettings);
    setV15Error(null);
    try {
      setDjSettings(await updateDjSettings(nextSettings));
    } catch (error) {
      setV15Error(error instanceof Error ? error.message : "DJ 设置保存失败。");
    }
  };

  const onToggleAutoSpeak = (enabled: boolean) => {
    autoSpeakRef.current = enabled;
    setAutoSpeak(enabled);
  };

  const onToggleRealtimeVoice = async () => {
    const controller = realtimeVoiceRef.current;
    if (!controller || realtimeStatus === "connecting") {
      return;
    }
    setSpeechNotice(null);
    if (controller.connected) {
      controller.stop();
      return;
    }
    try {
      await controller.start();
    } catch {
      // The controller reports a user-facing error through onError.
    }
  };

  const topTasteTags = useMemo(() => taste?.preferenceTags?.slice(0, 6) ?? [], [taste?.preferenceTags]);

  const trackTitle = now.track?.title ?? "等待开播";
  const isLive = Boolean(systemStatus?.ncmReachable);
  const favoritePeriod = taste?.favoritePeriods[0]?.period ?? "late_night";

  const visibleMessages = useMemo(
    () => {
      const unifiedMessages = [
        ...messages,
        ...(voicePreview ? [voicePreview] : []),
        ...(voiceAssistantDraft ? [voiceAssistantDraft] : [])
      ];
      return unifiedMessages.length > 0
        ? unifiedMessages
        : [
            {
              role: "assistant" as const,
              text:
                now.djScript?.text ??
                "嗨，我在这儿呀～告诉我你现在的心情或想听的感觉，我来陪你挑首合适的歌！",
              at: "station-intro"
            }
          ];
    },
    [messages, now.djScript?.text, voiceAssistantDraft, voicePreview]
  );

  const tickerItems = useMemo(() => {
    const items = [
      `曲库 ${systemStatus?.trackStatsCount ?? 0}`,
      `窗口 ${systemStatus?.queueLength ?? 0}`,
      systemStatus?.aiDjConfigured
        ? `AI ${systemStatus.aiDjProvider.toUpperCase()} ${systemStatus.aiDjModel ?? "ONLINE"}`
        : "AI FALLBACK",
      `偏好时段 ${PERIOD_LABELS[favoritePeriod] ?? favoritePeriod}`,
      ...topTasteTags.map((tag) => `#${tag.value}`),
      formatWeather(environment),
      `DJ ${djSettings.tone.toUpperCase()} / ${djSettings.voiceGender.toUpperCase()}`,
      `上次导入 ${formatTime(systemStatus?.lastImportAt)}`
    ];
    return items;
  }, [systemStatus, favoritePeriod, topTasteTags, environment, djSettings]);

  const tickerErrors = useMemo(
    () =>
      [
        systemStatus?.aiDjLastError ? `AI ${systemStatus.aiDjLastError}` : null,
        systemStatus?.lastImportError ?? null,
        importError,
        v15Error
      ].filter((item): item is string => Boolean(item)),
    [systemStatus, importError, v15Error]
  );

  return (
    <main className="deck" data-weather={environment?.weather ?? "unknown"} data-mobile-view={mobileView}>
      <AmbientBackdrop weather={environment?.weather} />

      <StatusRibbon
        importing={importing}
        isLive={isLive}
        recommendationLoading={recommendationLoading}
        weatherLoading={weatherLoading}
        onImportNcm={() => void onImportNcm()}
        onImportRecommendations={() => void onImportRecommendations()}
        onSyncWeather={() => void onSyncWeather()}
      />

      <div className="deck-grid">
        <div className="stage-column">
          <TurntableStage
            now={now}
            onFeedback={onFeedback}
            onFavorite={onFavorite}
            onPlaybackStateChange={onPlaybackStateChange}
            onRequestNext={onRequestNext}
            onTrackEnded={onTrackEnded}
            speechActive={speechActive}
          />
        </div>

        <ChatPanel
          activeSpeechKey={activeSpeechKey}
          activeTab={panelTab}
          autoSpeak={autoSpeak}
          canReplayDj={Boolean(now.djScript)}
          chatClearing={chatClearing}
          chatError={chatError}
          chatLoading={chatLoading}
          chatStreamFeedback={chatStreamFeedback}
          djSettings={djSettings}
          failedSpeechId={failedSpeechId}
          hasTrack={Boolean(now.track)}
          historyEmpty={messages.length === 0}
          loadingSpeechId={loadingSpeechId}
          memories={chatMemories}
          memoryBusyId={busyMemoryId}
          memoryClearing={memoryClearing}
          memoryError={memoryError}
          memoryOpen={memoryOpen}
          messages={visibleMessages}
          nowTitle={trackTitle}
          queue={now.queue}
          planPanel={<DailyPlanPanel />}
          queueLoadingTrackId={queueLoadingTrackId}
          realtimeStatus={realtimeStatus}
          realtimeStatusLabel={REALTIME_STATUS_LABELS[realtimeStatus]}
          speechNotice={speechNotice}
          streamingMessageAt={streamingMessageAt}
          streamingTextStore={streamingTextStore}
          suggestionLoadingId={suggestionLoadingId}
          inputRef={chatInputRef}
          onChangeTab={setPanelTab}
          onChangeTone={(tone) => void onChangeDjTone(tone)}
          onClearHistory={() => void onClearChatHistory()}
          onClearMemories={() => void onClearMemories()}
          onFeedbackContinue={() => {
            setChatStreamFeedback(null);
            chatInputRef.current?.focus();
          }}
          onFeedbackRetry={() => {
            const retryMessage = chatStreamFeedback?.retryMessage;
            setChatStreamFeedback(null);
            if (retryMessage) {
              void submitChat(retryMessage);
            }
          }}
          onForgetMemory={(memory) => void onForgetMemory(memory)}
          onPlaySuggestion={(suggestion) => void onPlaySuggestion(suggestion)}
          onPlayQueueTrack={(trackId) => void onPlayQueueTrack(trackId)}
          onQuickPrompt={(prompt) => void submitChat(prompt)}
          onReplayDj={() => {
            if (now.djScript) {
              void playDjScript(now.djScript, true);
            }
          }}
          onSpeakMessage={(message) => void playAssistantMessage(message, true)}
          onStopStream={stopActiveChatStream}
          onSubmit={(message) => void submitChat(message)}
          onToggleAutoSpeak={onToggleAutoSpeak}
          onToggleRealtimeVoice={() => void onToggleRealtimeVoice()}
          onToggleMemory={() => setMemoryOpen((open) => !open)}
        />
      </div>

      <SignalTicker items={tickerItems} errors={tickerErrors} />

      <nav className="mobile-nav" aria-label="移动端导航">
        <button
          type="button"
          className={mobileView === "stage" ? "mobile-nav-btn is-active" : "mobile-nav-btn"}
          aria-pressed={mobileView === "stage"}
          onClick={() => setMobileView("stage")}
        >
          <span aria-hidden="true">◉</span>
          唱机
        </button>
        <button
          type="button"
          className={mobileView === "panel" && panelTab === "chat" ? "mobile-nav-btn is-active" : "mobile-nav-btn"}
          aria-pressed={mobileView === "panel" && panelTab === "chat"}
          onClick={() => {
            setPanelTab("chat");
            setMobileView("panel");
          }}
        >
          <span aria-hidden="true">✦</span>
          对话
        </button>
        <button
          type="button"
          className={mobileView === "panel" && panelTab === "queue" ? "mobile-nav-btn is-active" : "mobile-nav-btn"}
          aria-pressed={mobileView === "panel" && panelTab === "queue"}
          onClick={() => {
            setPanelTab("queue");
            setMobileView("panel");
          }}
        >
          <span aria-hidden="true">≡</span>
          队列
        </button>
        <button
          type="button"
          className={mobileView === "panel" && panelTab === "plan" ? "mobile-nav-btn is-active" : "mobile-nav-btn"}
          aria-pressed={mobileView === "panel" && panelTab === "plan"}
          onClick={() => {
            setPanelTab("plan");
            setMobileView("panel");
          }}
        >
          <span aria-hidden="true">◷</span>
          今日
        </button>
      </nav>

      <audio ref={speechAudioRef} className="speech-audio" preload="none" />
    </main>
  );
}
