import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import type {
  ChatMessage,
  ChatStreamEvent,
  DjSettings,
  EnvironmentContext,
  NowPlayingState,
  SystemStatus,
  TasteProfile,
  TrackLyrics,
  WsPayload
} from "@musicgpt/shared";
import {
  ChatStreamInterruptedError,
  clearChatHistory,
  fetchDjSettings,
  fetchEnvironment,
  fetchChatHistory,
  fetchNowPlaying,
  fetchSystemStatus,
  fetchTaste,
  importRecommendations,
  importFromNcm,
  generateChatSpeech,
  playSuggestedTrack,
  requestNext,
  sendChatStream,
  sendFeedback,
  updateDjSettings,
  updateEnvironmentLocation
} from "./api";
import aiDjAvatarUrl from "./assets/ai-dj-avatar.svg";
import { findActiveLyricIndex, selectLyricWindow } from "./lyrics";
import { useWsStream } from "./useWsStream";
import {
  applyPlayerVolume,
  DEFAULT_PLAYER_VOLUME,
  loadPlayerVolume,
  normalizeVolumeLevel,
  savePlayerVolume
} from "./volume";
import {
  getDuckedPlayerVolume,
  loadAutoSpeak,
  saveAutoSpeak,
  SpeechPlaybackController
} from "./speech";

function formatArtists(artists: string[] | undefined): string {
  if (!artists || artists.length === 0) {
    return "未知艺术家";
  }
  return artists.join(" / ");
}

function formatDate(now: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
  const day = new Intl.DateTimeFormat("en-US", { day: "2-digit" }).format(now);
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(now);
  const year = new Intl.DateTimeFormat("en-US", { year: "numeric" }).format(now);
  return `${weekday} / ${day} ${month.toUpperCase()} ${year}`;
}

function formatClock(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return "未导入";
  }
  return new Date(value).toLocaleString();
}

function formatWeather(environment: EnvironmentContext | null): string {
  if (!environment) {
    return "WEATHER --";
  }
  const labels: Record<EnvironmentContext["weather"], string> = {
    clear: "CLEAR",
    cloudy: "CLOUDY",
    rain: "RAIN",
    snow: "SNOW",
    fog: "FOG",
    storm: "STORM",
    unknown: "WEATHER --"
  };
  const temp = typeof environment.temperature === "number" ? ` ${environment.temperature}C` : "";
  return `${labels[environment.weather]}${temp}`;
}

const DEFAULT_DJ_SETTINGS: DjSettings = {
  tone: "lively",
  voiceGender: "female",
  voice: "zh-CN-XiaoxiaoNeural"
};

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0:00";
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

const EMPTY_LYRIC_LINES: TrackLyrics["lines"] = [];

const WeatherParticles = memo(function WeatherParticles() {
  return (
    <div className="weather-particles" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
});

const StationClock = memo(function StationClock({ isLive }: { isLive: boolean }) {
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="clock-stage" aria-label="On air status">
      <div className="clock-card">
        <p className="micro-label">Station time</p>
        <h1>{formatClock(clock)}</h1>
        <p className="date-line">{formatDate(clock)}</p>
      </div>
      <div className={isLive ? "live-signal is-live" : "live-signal"}>
        <span aria-hidden="true" />
        {isLive ? "ON AIR" : "OFFLINE"}
      </div>
    </section>
  );
});

interface LyricsWindowProps {
  activeIndex: number;
  lyrics: TrackLyrics | undefined;
}

interface LyricLineRowProps {
  isActive: boolean;
  line: TrackLyrics["lines"][number];
  pulse: number | undefined;
}

const LyricLineRow = memo(function LyricLineRow({ isActive, line, pulse }: LyricLineRowProps) {
  return (
    <div
      className={isActive ? `lyric-line is-active pulse-${pulse ?? 0}` : "lyric-line"}
      aria-current={isActive ? "true" : undefined}
    >
      <p className="lyric-original">{line.text}</p>
      {line.translation ? <span className="lyric-translation">{line.translation}</span> : null}
    </div>
  );
});

const LyricsWindow = memo(function LyricsWindow({ activeIndex, lyrics }: LyricsWindowProps) {
  const [pulseKey, setPulseKey] = useState(0);
  const lines = lyrics?.lines ?? EMPTY_LYRIC_LINES;
  const visibleLines = useMemo(
    () => selectLyricWindow(lines, activeIndex),
    [activeIndex, lines]
  );

  useEffect(() => {
    if (activeIndex < 0) {
      return undefined;
    }
    setPulseKey((key) => key + 1);
    return undefined;
  }, [activeIndex, lyrics?.trackId]);

  if (lyrics?.pureMusic) {
    return (
      <div className="lyrics-window">
        <div className="lyric-line pure-music is-active">Pure music, please enjoy</div>
      </div>
    );
  }

  return (
    <div className="lyrics-window">
      {visibleLines.length > 0 ? (
        visibleLines.map(({ index, line }) => {
          const isActive = index === activeIndex;
          return (
            <LyricLineRow
              key={`${index}-${line.timeMs}-${line.text}`}
              isActive={isActive}
              line={line}
              pulse={isActive ? pulseKey % 2 : undefined}
            />
          );
        })
      ) : (
        <div className="lyric-line pure-music">Waiting for lyrics</div>
      )}
    </div>
  );
});

interface MessageListProps {
  activeSpeechKey: string | undefined;
  chatLoading: boolean;
  failedSpeechId: number | null;
  loadingSpeechId: number | null;
  messages: ChatMessage[];
  onPlaySuggestion: (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => Promise<void>;
  onSpeakMessage: (message: ChatMessage) => Promise<void>;
  streamingMessageAt: string | null;
  suggestionLoadingId: string | null;
}

const MessageList = memo(function MessageList({
  activeSpeechKey,
  chatLoading,
  failedSpeechId,
  loadingSpeechId,
  messages,
  onPlaySuggestion,
  onSpeakMessage,
  streamingMessageAt,
  suggestionLoadingId
}: MessageListProps) {
  const messageThreadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const thread = messageThreadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }, [messages.length, messages.at(-1)?.text, chatLoading]);

  return (
    <div className="message-thread" ref={messageThreadRef}>
      {messages.map((message, index) => {
        const isStreaming = message.at === streamingMessageAt;
        return (
        <div
          className={message.role === "assistant" ? "message-row assistant-row" : "message-row user-row"}
          key={`${message.at}-${index}`}
        >
          {message.role === "assistant" ? (
            <div className="avatar small dj-avatar" aria-hidden="true">
              <img alt="" src={aiDjAvatarUrl} />
            </div>
          ) : null}
          <div className={message.role === "assistant" ? "message-bubble" : "message-bubble user-bubble"}>
            <div className="message-copy-row">
              <p>
                {message.text}
                {isStreaming ? <span className="streaming-caret" aria-label="正在生成回复" /> : null}
              </p>
              {message.role === "assistant" && message.id ? (
                <button
                  className="speech-button"
                  type="button"
                  aria-label={
                    activeSpeechKey === `chat:${message.id}`
                      ? "停止朗读"
                      : failedSpeechId === message.id
                        ? "重试朗读"
                        : "朗读这条回复"
                  }
                  aria-pressed={activeSpeechKey === `chat:${message.id}`}
                  onClick={() => void onSpeakMessage(message)}
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
            {message.role === "assistant" && message.trackSuggestion ? (
              <button
                className="track-suggestion"
                type="button"
                onClick={() => void onPlaySuggestion(message.trackSuggestion!)}
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

interface PlayerStackProps {
  now: NowPlayingState;
  onFeedback: (type: "skip" | "like" | "replay" | "complete") => Promise<void>;
  onPlaybackStateChange: (paused: boolean) => void;
  onRequestNext: (recordSkip?: boolean) => Promise<void>;
  onTrackEnded: () => Promise<void>;
  speechActive: boolean;
}

const PlayerStack = memo(function PlayerStack({
  now,
  onFeedback,
  onPlaybackStateChange,
  onRequestNext,
  onTrackEnded,
  speechActive
}: PlayerStackProps) {
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playerVolume, setPlayerVolume] = useState(() => loadPlayerVolume(getBrowserStorage()));
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastAudibleVolumeRef = useRef(
    playerVolume.level > 0 ? playerVolume.level : DEFAULT_PLAYER_VOLUME.level
  );
  const lyricLines = now.lyrics?.lines ?? EMPTY_LYRIC_LINES;
  const activeLyricIndex = useMemo(
    () => findActiveLyricIndex(lyricLines, audioTime * 1000),
    [audioTime, lyricLines]
  );

  useEffect(() => {
    setAudioTime(0);
    setAudioDuration(0);
  }, [now.track]);

  useEffect(() => {
    if (audioRef.current) {
      applyPlayerVolume(audioRef.current, getDuckedPlayerVolume(playerVolume, speechActive));
    }
    savePlayerVolume(getBrowserStorage(), playerVolume);
  }, [playerVolume, speechActive]);

  const onTogglePlayback = async () => {
    if (!audioRef.current) {
      return;
    }
    if (playbackPaused) {
      try {
        await audioRef.current.play();
        setPlaybackPaused(false);
        onPlaybackStateChange(false);
      } catch {
        setPlaybackPaused(true);
      }
      return;
    }
    audioRef.current.pause();
    setPlaybackPaused(true);
    onPlaybackStateChange(true);
  };

  const onSeek = (value: number) => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.currentTime = value;
    setAudioTime(value);
  };

  const onReplay = async () => {
    await onFeedback("replay");
    if (!audioRef.current) {
      return;
    }
    audioRef.current.currentTime = 0;
    await audioRef.current.play().catch(() => undefined);
  };

  const onChangeVolume = (percent: number) => {
    const level = normalizeVolumeLevel(percent / 100);
    if (level > 0) {
      lastAudibleVolumeRef.current = level;
    }
    setPlayerVolume({ level, muted: level === 0 });
  };

  const onToggleMute = () => {
    setPlayerVolume((current) => {
      const isSilent = current.muted || current.level === 0;
      if (!isSilent) {
        return { ...current, muted: true };
      }
      const level = current.level > 0 ? current.level : lastAudibleVolumeRef.current;
      return { level, muted: false };
    });
  };

  const volumePercent = Math.round(playerVolume.level * 100);
  const volumeMuted = playerVolume.muted || volumePercent === 0;

  return (
    <section className="player-stack" aria-label="Audio and lyrics">
      <article className="player-card">
        <header className="card-header">
          <div>
            <p className="micro-label">Now playing</p>
            <h2>{now.track?.title ?? "等待开播"}</h2>
          </div>
          <span className="status-chip">{playbackPaused ? "PAUSED" : "PLAYING"}</span>
        </header>
        <div className="player-body">
          <div className="cover-frame" aria-hidden="true">
            {now.track?.coverUrl ? <img alt="" src={now.track.coverUrl} /> : <span>NW</span>}
          </div>
          <div className="track-deck">
            <p className="artist-line">{formatArtists(now.track?.artists)}</p>
            <div className="equalizer" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="controls" aria-label="Playback controls">
              <button type="button" aria-label="Replay" onClick={() => void onReplay()}>
                <span aria-hidden="true">|&lt;</span>
              </button>
              <button
                type="button"
                aria-label="Play or pause"
                className="control-primary"
                onClick={() => void onTogglePlayback()}
              >
                <span aria-hidden="true">{playbackPaused ? ">" : "||"}</span>
              </button>
              <button type="button" aria-label="Next" onClick={() => void onRequestNext(true)}>
                <span aria-hidden="true">&gt;|</span>
              </button>
              <button type="button" aria-label="Like" onClick={() => void onFeedback("like")}>
                <span aria-hidden="true">♡</span>
              </button>
            </div>
            <div className="volume-control">
              <button
                type="button"
                className="volume-button"
                aria-label={volumeMuted ? "Unmute" : "Mute"}
                aria-pressed={volumeMuted}
                onClick={onToggleMute}
              >
                <span aria-hidden="true">{volumeMuted ? "×" : "◖"}</span>
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={volumePercent}
                onChange={(event) => onChangeVolume(Number(event.currentTarget.value))}
                aria-label="Playback volume"
                aria-valuetext={`${volumePercent}%`}
              />
              <output aria-live="polite">{volumePercent}%</output>
            </div>
          </div>
        </div>
        <div className="progress-row">
          <span>{formatDuration(audioTime)}</span>
          <input
            type="range"
            min={0}
            max={audioDuration || 0}
            value={Math.min(audioTime, audioDuration || 0)}
            step={1}
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
            aria-label="Seek current track"
          />
          <span>{formatDuration(audioDuration)}</span>
        </div>
        <audio
          ref={audioRef}
          autoPlay
          src={now.track?.songUrl}
          onEnded={() => void onTrackEnded()}
          onPlay={() => setPlaybackPaused(false)}
          onPause={() => setPlaybackPaused(true)}
          onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration)}
          className="audio"
        />
      </article>

      <article className="lyrics-card" aria-label="Lyrics preview">
        <header className="card-header compact">
          <div>
            <p className="micro-label">Lyrics</p>
            <h2>Scrolling window</h2>
          </div>
          <span className="status-chip muted">{now.lyrics?.pureMusic ? "PURE" : "SYNC"}</span>
        </header>
        <LyricsWindow activeIndex={activeLyricIndex} lyrics={now.lyrics} />
      </article>
    </section>
  );
});

export default function App() {
  const [now, setNow] = useState<NowPlayingState>({ queue: [], paused: false });
  const [taste, setTaste] = useState<TasteProfile | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentContext | null>(null);
  const [djSettings, setDjSettings] = useState<DjSettings>(DEFAULT_DJ_SETTINGS);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
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
  const [loading, setLoading] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const currentTrackRef = useRef<NowPlayingState["track"]>(undefined);
  const advanceInFlightRef = useRef(false);
  const speechAudioRef = useRef<HTMLAudioElement>(null);
  const speechControllerRef = useRef<SpeechPlaybackController | null>(null);
  const speechRequestTokenRef = useRef(0);
  const chatStreamAbortRef = useRef<AbortController | null>(null);
  const chatStreamTokenRef = useRef(0);
  const autoSpeakRef = useRef(autoSpeak);

  const refresh = useCallback(async () => {
    const [nowState, tasteProfile, status, chatHistory, environmentContext, settings] = await Promise.all([
      fetchNowPlaying(),
      fetchTaste(),
      fetchSystemStatus(),
      fetchChatHistory().catch(() => []),
      fetchEnvironment().catch(() => null),
      fetchDjSettings().catch(() => DEFAULT_DJ_SETTINGS)
    ]);
    setNow(nowState);
    setTaste(tasteProfile);
    setSystemStatus(status);
    setMessages(chatHistory);
    setEnvironment(environmentContext);
    setDjSettings(settings);
  }, []);

  const refreshTaste = useCallback(async () => {
    setTaste(await fetchTaste());
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => undefined)
      .finally(() => setLoading(false));
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
        setSpeechNotice("浏览器没有让语音自动播放，点一下回复旁的小喇叭就好啦～");
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

  const playAssistantMessage = useCallback(async (message: ChatMessage, manual = false) => {
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
      chatStreamAbortRef.current?.abort();
      chatStreamAbortRef.current = null;
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
      const played = await controller.playNow({
        key,
        audioUrl: speech.audioUrl,
        kind: "chat"
      });
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
  }, []);

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

  const onWsPayload = useCallback((payload: WsPayload) => {
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
    }
  }, [playDjScript]);

  useWsStream(onWsPayload);

  const onSubmitChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitChat(input);
  };

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
    let resultReceived = false;
    setInput("");
    setChatError(null);
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
            setMessages((current) =>
              current.map((item) =>
                item.at === streamAt
                  ? { ...item, text: `${item.text}${event.delta}` }
                  : item
              )
            );
          } else if (event.type === "speech" && autoSpeakRef.current) {
            speechControllerRef.current?.enqueueChatSegment(streamKey, {
              key: `${streamKey}:${event.sequence}`,
              audioUrl: event.audioUrl,
              kind: "chat"
            });
          } else if (event.type === "result") {
            resultReceived = true;
            setMessages(event.response.messages);
            setNow(event.response.now);
            setStreamingMessageAt(null);
          }
        }
      });
      await refreshTaste();
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      if (!aborted && chatStreamTokenRef.current === streamToken) {
        const interrupted = error instanceof ChatStreamInterruptedError;
        setChatError(
          interrupted
            ? "连接刚刚抖了一下，已经收到的回复还在，再发一次就好啦～"
            : error instanceof Error
              ? error.message
              : "GPT DJ 暂时掉线了。"
        );
        if (!resultReceived) {
          const history = await fetchChatHistory().catch(() => undefined);
          if (history?.at(-1)?.role === "assistant") {
            setMessages(history);
          } else if (!interrupted) {
            if (history) {
              setMessages(history);
            } else {
              setMessages((current) => current.filter((item) => item.at !== streamAt));
            }
          } else {
            setMessages((current) =>
              current.some((item) => item.at === streamAt && item.text.trim())
                ? current
                : current.filter((item) => item.at !== streamAt)
            );
          }
        }
      }
    } finally {
      speechControllerRef.current?.finishChatStream(streamKey);
      if (chatStreamAbortRef.current === abortController) {
        chatStreamAbortRef.current = null;
      }
      if (chatStreamTokenRef.current === streamToken) {
        setStreamingMessageAt(null);
        setChatLoading(false);
      }
    }
  };

  const onPlaySuggestion = useCallback(async (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => {
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
  }, [refreshTaste, suggestionLoadingId]);

  const onClearChatHistory = async () => {
    if (chatLoading || chatClearing || messages.length === 0) {
      return;
    }
    const confirmed = window.confirm("确定清空全部历史聊天记录吗？此操作无法撤销。");
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

  const onRequestNext = useCallback(async (recordSkip = false) => {
    await runWithAdvanceLock(async () => {
      const currentTrack = currentTrackRef.current;
      if (recordSkip && currentTrack) {
        await sendFeedback({ type: "skip", trackId: currentTrack.id });
      }
      const response = await requestNext();
      setNow(response.now);
      await refreshTaste();
    });
  }, [refreshTaste, runWithAdvanceLock]);

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

  const onFeedback = useCallback(async (type: "skip" | "like" | "replay" | "complete") => {
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
  }, [onRequestNext, refreshTaste]);

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

  const favoritePeriod = useMemo(
    () => taste?.favoritePeriods[0]?.period ?? "night",
    [taste?.favoritePeriods]
  );

  const trackTitle = now.track?.title ?? "等待开播";
  const isLive = Boolean(systemStatus?.ncmReachable);
  const queuePreview = now.queue.slice(0, 10);
  const nextTrack = now.queue[0]?.track;
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

  return (
    <main className={`radio-shell weather-${environment?.weather ?? "unknown"}`}>
      <div className="breathing-light" aria-hidden="true" />
      <WeatherParticles />
      <header className="topbar" aria-label="Neonwave FM station header">
        <div className="brand">
          <div className="avatar brand-avatar" aria-hidden="true">
            <img alt="" src={aiDjAvatarUrl} />
          </div>
          <div>
            <div className="wordmark">Neonwave FM</div>
            <p className="brand-subline">{isLive ? "ON AIR" : "LOCAL SIGNAL"}</p>
          </div>
        </div>
        <nav className="station-actions" aria-label="Station actions">
          <button className="pill muted" type="button">
            Login
          </button>
          <button className="pill active" type="button">
            Dark
          </button>
          <button className="pill muted" type="button" onClick={() => void onImportNcm()} disabled={importing}>
            {importing ? "Importing" : "Sync"}
          </button>
          <button className="pill muted" type="button" onClick={() => void onSyncWeather()} disabled={weatherLoading}>
            {weatherLoading ? "Weather..." : "Weather"}
          </button>
          <button
            className="pill muted"
            type="button"
            onClick={() => void onImportRecommendations()}
            disabled={recommendationLoading}
          >
            {recommendationLoading ? "Tuning..." : "Expand"}
          </button>
        </nav>
      </header>

      <StationClock isLive={isLive} />

      <section className="console-grid" aria-label="Neonwave main console">
        <PlayerStack
          now={now}
          onFeedback={onFeedback}
          onPlaybackStateChange={onPlaybackStateChange}
          onRequestNext={onRequestNext}
          onTrackEnded={onTrackEnded}
          speechActive={speechActive}
        />

        <article className="dj-console" aria-label="GPT DJ conversation">
          <header className="card-header">
            <div>
              <p className="micro-label">GPT DJ window</p>
              <h2>Conversation</h2>
            </div>
            <div className="dj-settings-bar">
              <select
                value={djSettings.tone}
                onChange={(event) => void onChangeDjTone(event.currentTarget.value as DjSettings["tone"])}
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
                />
                自动朗读
              </label>
              <span className="context-chip">全程小晓声线</span>
            </div>
          </header>
          <MessageList
            activeSpeechKey={activeSpeechKey}
            chatLoading={chatLoading}
            failedSpeechId={failedSpeechId}
            loadingSpeechId={loadingSpeechId}
            messages={visibleMessages}
            onPlaySuggestion={onPlaySuggestion}
            onSpeakMessage={(message) => playAssistantMessage(message, true)}
            streamingMessageAt={streamingMessageAt}
            suggestionLoadingId={suggestionLoadingId}
          />
          <p className="now-caption">Now playing: {trackTitle}</p>
          <div className="chat-actions" aria-label="GPT DJ quick actions">
            <button type="button" onClick={() => void submitChat("点评当前这首")} disabled={chatLoading || !now.track}>
              点评当前
            </button>
            <button type="button" onClick={() => void submitChat("来点适合现在氛围的歌")} disabled={chatLoading}>
              氛围点歌
            </button>
            {now.djScript?.audioUrl ? (
              <button type="button" onClick={() => void playDjScript(now.djScript!, true)}>
                重播最近播报
              </button>
            ) : null}
            <button
              className="clear-chat-button"
              type="button"
              onClick={() => void onClearChatHistory()}
              disabled={chatLoading || chatClearing || messages.length === 0}
            >
              {chatClearing ? "清空中…" : "清空历史"}
            </button>
          </div>
          {chatError ? <p className="chat-error">{chatError}</p> : null}
          {speechNotice ? <p className="speech-notice">{speechNotice}</p> : null}
          <form onSubmit={onSubmitChat} className="chat-form">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="描述你想听的歌、点歌，或让 GPT DJ 点评当前曲目..."
              aria-label="Message Neonwave FM"
              disabled={chatLoading}
            />
            <button type="submit" aria-label="Send message" disabled={chatLoading}>
              {chatLoading ? "..." : "→"}
            </button>
          </form>
          <audio ref={speechAudioRef} className="speech-audio" preload="none" />
        </article>
      </section>

      <aside className="signal-strip" aria-label="Station details">
        <span>Library {systemStatus?.trackStatsCount ?? 0}</span>
        <span>Window {systemStatus?.queueLength ?? 0}</span>
        <span>
          {systemStatus?.aiDjConfigured
            ? `AI ${systemStatus.aiDjProvider.toUpperCase()} ${systemStatus.aiDjModel ?? "ONLINE"}`
            : "AI FALLBACK"}
        </span>
        <span>Taste {favoritePeriod}</span>
        <span>{formatWeather(environment)}</span>
        <span>DJ {djSettings.tone.toUpperCase()} / {djSettings.voiceGender.toUpperCase()}</span>
        <span>Import {formatTime(systemStatus?.lastImportAt)}</span>
        {systemStatus?.aiDjLastError ? <span className="error-text">AI {systemStatus.aiDjLastError}</span> : null}
        {systemStatus?.lastImportError ? <span className="error-text">{systemStatus.lastImportError}</span> : null}
        {importError ? <span className="error-text">{importError}</span> : null}
        {v15Error ? <span className="error-text">{v15Error}</span> : null}
      </aside>

      <section className={queueOpen ? "queue-drawer is-open" : "queue-drawer"} aria-label="Queue drawer">
        <button className="queue-summary" type="button" onClick={() => setQueueOpen((open) => !open)}>
          <span>QUEUE</span>
          <strong>{now.queue.length} TRACKS</strong>
          <em>NEXT: {nextTrack ? `${nextTrack.title} / ${formatArtists(nextTrack.artists)}` : "waiting for signal"}</em>
          <b aria-hidden="true">{queueOpen ? "×" : "+"}</b>
        </button>
        <div className="queue-panel">
          <ol>
            {queuePreview.length > 0 ? (
              queuePreview.map((item, index) => (
                <li key={item.track.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{item.track.title}</strong>
                  <em>{formatArtists(item.track.artists)}</em>
                </li>
              ))
            ) : (
              <li className="empty-queue">
                <span>00</span>
                <strong>{loading ? "Tuning library" : "Queue empty"}</strong>
                <em>Neonwave will refill the window on the next request</em>
              </li>
            )}
          </ol>
        </div>
      </section>
    </main>
  );
}
