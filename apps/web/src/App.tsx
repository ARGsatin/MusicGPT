import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMemory,
  ChatMessage,
  ChatStreamEvent,
  DjSettings,
  EnvironmentContext,
  NowPlayingState,
  SystemStatus,
  TasteProfile,
  WsPayload
} from "@musicgpt/shared";
import {
  clearChatMemories,
  clearChatHistory,
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
  generateChatSpeech,
  playSuggestedTrack,
  requestNext,
  setFavorite as updateFavorite,
  sendChatStream,
  sendFeedback,
  updateDjSettings,
  updateEnvironmentLocation
} from "./api";
import { AmbientBackdrop } from "./components/AmbientBackdrop";
import { ChatPanel, type PanelTab } from "./components/ChatPanel";
import { SignalTicker, StatusRibbon } from "./components/StatusRibbon";
import { TurntableStage } from "./components/TurntableStage";
import { settleChatStreamFailure, type ChatStreamFeedback } from "./chatStream";
import { useWsStream } from "./useWsStream";
import { loadAutoSpeak, saveAutoSpeak, SpeechPlaybackController } from "./speech";

const DEFAULT_DJ_SETTINGS: DjSettings = {
  tone: "lively",
  voiceGender: "female",
  voice: "zh-CN-XiaoxiaoNeural"
};

interface ActiveChatStream {
  abortController: AbortController;
  receivedText: string;
  retryMessage: string;
  streamAt: string;
  token: number;
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
  const [chatMemories, setChatMemories] = useState<ChatMemory[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [busyMemoryId, setBusyMemoryId] = useState<number | null>(null);
  const [memoryClearing, setMemoryClearing] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatStreamFeedback, setChatStreamFeedback] = useState<ChatStreamFeedback | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatClearing, setChatClearing] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(() => loadAutoSpeak(getBrowserStorage()));
  const [speechActive, setSpeechActive] = useState(false);
  const [activeSpeechKey, setActiveSpeechKey] = useState<string | undefined>(undefined);
  const [loadingSpeechId, setLoadingSpeechId] = useState<number | null>(null);
  const [failedSpeechId, setFailedSpeechId] = useState<number | null>(null);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [streamingMessageAt, setStreamingMessageAt] = useState<string | null>(null);
  const [suggestionLoadingId, setSuggestionLoadingId] = useState<string | null>(null);
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
  const speechControllerRef = useRef<SpeechPlaybackController | null>(null);
  const speechRequestTokenRef = useRef(0);
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const chatStreamTokenRef = useRef(0);
  const activeChatStreamRef = useRef<ActiveChatStream | null>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const autoSpeakRef = useRef(autoSpeak);

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
    const controller = new SpeechPlaybackController(audio, {
      onActiveChange: setSpeechActive,
      onPlayingKeyChange: setActiveSpeechKey,
      onPlaybackError: (job) => {
        if (job.kind === "chat" && job.key.startsWith("chat:")) {
          const messageId = Number(job.key.split(":")[1]);
          setFailedSpeechId(Number.isFinite(messageId) ? messageId : null);
        }
        setSpeechNotice("语音播放出错，文字回复已保留；可以点回复旁的播放按钮重试。");
      }
    });
    speechControllerRef.current = controller;
    return () => {
      chatStreamAbortRef.current?.abort();
      controller.dispose();
      speechControllerRef.current = null;
    };
  }, []);

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
    speechControllerRef.current?.stop(true);
    setMessages((current) =>
      settleChatStreamFailure(current, {
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
  }, []);

  const playAssistantMessage = useCallback(
    async (message: ChatMessage, manual = false) => {
      if (!message.id) {
        return;
      }
      const controller = speechControllerRef.current;
      if (!controller) {
        return;
      }
      const key = `chat:${message.id}`;
      if (manual && controller.isPlaying(key)) {
        controller.stop();
        return;
      }
      if (manual) {
        stopActiveChatStream();
        controller.stop();
      }
      const requestToken = ++speechRequestTokenRef.current;
      setLoadingSpeechId(message.id);
      setFailedSpeechId(null);
      setSpeechNotice(null);
      try {
        const speech = await generateChatSpeech(message.id);
        if (requestToken !== speechRequestTokenRef.current) {
          return;
        }
        const jobs = speech.segments?.length
          ? speech.segments.map((segment) => ({
              key,
              audioUrl: segment.audioUrl,
              kind: "chat" as const
            }))
          : [{ key, audioUrl: speech.audioUrl, kind: "chat" as const }];
        const played = await controller.playSequence(jobs);
        if (!played) {
          setFailedSpeechId(message.id);
        }
      } catch {
        if (requestToken === speechRequestTokenRef.current) {
          setFailedSpeechId(message.id);
          setSpeechNotice("语音刚刚没准备好，文字还在，等会儿再点一次试试呀～");
        }
      } finally {
        if (requestToken === speechRequestTokenRef.current) {
          setLoadingSpeechId((current) => (current === message.id ? null : current));
        }
      }
    },
    [stopActiveChatStream]
  );

  const playDjScript = useCallback(async (script: NonNullable<NowPlayingState["djScript"]>, manual = false) => {
    if (!script.audioUrl) {
      return;
    }
    const controller = speechControllerRef.current;
    if (!controller) {
      return;
    }
    const job = {
      key: `dj:${script.id}`,
      audioUrl: script.audioUrl,
      kind: "dj" as const
    };
    setSpeechNotice(null);
    if (manual) {
      await controller.playNow(job);
      return;
    }
    controller.enqueueDj(job);
  }, []);

  const onWsPayload = useCallback(
    (payload: WsPayload) => {
      if (payload.event === "now_playing_updated") {
        setNow(payload.data as NowPlayingState);
      } else if (payload.event === "queue_updated") {
        setNow((current) => ({ ...current, queue: payload.data as NowPlayingState["queue"] }));
      } else if (payload.event === "dj_tts_ready") {
        const script = payload.data as NowPlayingState["djScript"];
        setNow((current) => (script ? { ...current, djScript: script } : { ...current }));
        if (script?.audioUrl && autoSpeakRef.current) {
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
    const optimistic: ChatMessage = { role: "user", text: message, at: new Date().toISOString() };
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
    setInput("");
    setChatError(null);
    setChatStreamFeedback(null);
    setSpeechNotice(null);
    setChatLoading(true);
    setStreamingMessageAt(streamAt);
    setMessages((current) => [...current, optimistic, streamingAssistant]);
    try {
      await sendChatStream(message, {
        synthesizeSpeech: autoSpeakRef.current,
        signal: abortController.signal,
        onEvent: (event: ChatStreamEvent) => {
          if (chatStreamTokenRef.current !== streamToken) {
            return;
          }
          if (event.type === "text_delta") {
            activeStream.receivedText += event.delta;
            setMessages((current) =>
              current.map((item) => (item.at === streamAt ? { ...item, text: `${item.text}${event.delta}` } : item))
            );
          } else if (event.type === "speech" && autoSpeakRef.current) {
            speechControllerRef.current?.enqueueChatSegment(streamKey, {
              key: `${streamKey}:${event.sequence}`,
              audioUrl: event.audioUrl,
              kind: "chat"
            });
          } else if (event.type === "result") {
            if (activeChatStreamRef.current?.token === streamToken) {
              activeChatStreamRef.current = null;
            }
            setMessages(event.response.messages);
            setNow(event.response.now);
            setStreamingMessageAt(null);
          }
        }
      });
      await refreshTaste().catch(() => undefined);
    } catch {
      if (!abortController.signal.aborted && chatStreamTokenRef.current === streamToken) {
        setMessages((current) =>
          settleChatStreamFailure(current, {
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
      speechControllerRef.current?.finishChatStream(streamKey);
      if (chatStreamAbortRef.current === abortController) {
        chatStreamAbortRef.current = null;
      }
      if (chatStreamTokenRef.current === streamToken) {
        if (activeChatStreamRef.current?.token === streamToken) {
          activeChatStreamRef.current = null;
        }
        setStreamingMessageAt(null);
        setChatLoading(false);
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
      speechRequestTokenRef.current += 1;
      speechControllerRef.current?.stop(true);
      setMessages([]);
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
    if (!enabled) {
      speechRequestTokenRef.current += 1;
      speechControllerRef.current?.stop(true);
      setLoadingSpeechId(null);
    }
  };

  const topTasteTags = useMemo(() => taste?.preferenceTags?.slice(0, 6) ?? [], [taste?.preferenceTags]);

  const trackTitle = now.track?.title ?? "等待开播";
  const isLive = Boolean(systemStatus?.ncmReachable);
  const favoritePeriod = taste?.favoritePeriods[0]?.period ?? "late_night";

  const visibleMessages = useMemo(
    () =>
      messages.length > 0
        ? messages
        : [
            {
              role: "assistant" as const,
              text:
                now.djScript?.text ??
                "嗨，我在这儿呀～告诉我你现在的心情或想听的感觉，我来陪你挑首合适的歌！",
              at: "station-intro"
            }
          ],
    [messages, now.djScript?.text]
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
          canReplayDj={Boolean(now.djScript?.audioUrl)}
          chatClearing={chatClearing}
          chatError={chatError}
          chatLoading={chatLoading}
          chatStreamFeedback={chatStreamFeedback}
          djSettings={djSettings}
          failedSpeechId={failedSpeechId}
          hasTrack={Boolean(now.track)}
          historyEmpty={messages.length === 0}
          input={input}
          loadingSpeechId={loadingSpeechId}
          memories={chatMemories}
          memoryBusyId={busyMemoryId}
          memoryClearing={memoryClearing}
          memoryError={memoryError}
          memoryOpen={memoryOpen}
          messages={visibleMessages}
          nowTitle={trackTitle}
          queue={now.queue}
          speechNotice={speechNotice}
          streamingMessageAt={streamingMessageAt}
          suggestionLoadingId={suggestionLoadingId}
          inputRef={chatInputRef}
          onChangeInput={setInput}
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
          onQuickPrompt={(prompt) => void submitChat(prompt)}
          onReplayDj={() => {
            if (now.djScript) {
              void playDjScript(now.djScript, true);
            }
          }}
          onSpeakMessage={(message) => void playAssistantMessage(message, true)}
          onStopStream={stopActiveChatStream}
          onSubmit={() => void submitChat(input)}
          onToggleAutoSpeak={onToggleAutoSpeak}
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
      </nav>

      <audio ref={speechAudioRef} className="speech-audio" preload="none" />
    </main>
  );
}
