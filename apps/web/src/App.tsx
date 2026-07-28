import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import type {
  ChatMessage,
  DjSettings,
  EnvironmentContext,
  NowPlayingState,
  SystemStatus,
  TasteProfile,
  TrackLyrics,
  WsPayload
} from "@musicgpt/shared";
import {
  fetchDjSettings,
  fetchEnvironment,
  fetchChatHistory,
  fetchNowPlaying,
  fetchSystemStatus,
  fetchTaste,
  importRecommendations,
  importFromNcm,
  playSuggestedTrack,
  requestNext,
  sendChat,
  sendFeedback,
  updateDjSettings,
  updateEnvironmentLocation
} from "./api";
import aiDjAvatarUrl from "./assets/ai-dj-avatar.svg";
import { findActiveLyricIndex } from "./lyrics";
import { useWsStream } from "./useWsStream";

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
  const lyricsWindowRef = useRef<HTMLDivElement | null>(null);
  const lines = lyrics?.lines ?? EMPTY_LYRIC_LINES;

  useEffect(() => {
    if (activeIndex < 0) {
      return undefined;
    }
    setPulseKey((key) => key + 1);
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        lyricsWindowRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({
          block: "center",
          behavior: "smooth"
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [activeIndex, lyrics?.trackId]);

  if (lyrics?.pureMusic) {
    return (
      <div className="lyrics-window">
        <div className="lyric-line pure-music is-active">Pure music, please enjoy</div>
      </div>
    );
  }

  return (
    <div className="lyrics-window" ref={lyricsWindowRef}>
      {lines.length > 0 ? (
        lines.map((line, index) => {
          const isActive = index === activeIndex;
          return (
            <LyricLineRow
              key={`${line.timeMs}-${line.text}`}
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
  chatLoading: boolean;
  messages: ChatMessage[];
  onPlaySuggestion: (suggestion: NonNullable<ChatMessage["trackSuggestion"]>) => Promise<void>;
  suggestionLoadingId: string | null;
}

const MessageList = memo(function MessageList({
  chatLoading,
  messages,
  onPlaySuggestion,
  suggestionLoadingId
}: MessageListProps) {
  const messageThreadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const thread = messageThreadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }, [messages.length, chatLoading]);

  return (
    <div className="message-thread" ref={messageThreadRef}>
      {messages.map((message, index) => (
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
            <p>{message.text}</p>
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
      ))}
    </div>
  );
});

interface PlayerStackProps {
  now: NowPlayingState;
  onFeedback: (type: "skip" | "like" | "replay" | "complete") => Promise<void>;
  onPlaybackStateChange: (paused: boolean) => void;
  onRequestNext: (recordSkip?: boolean) => Promise<void>;
  onTrackEnded: () => Promise<void>;
}

const PlayerStack = memo(function PlayerStack({
  now,
  onFeedback,
  onPlaybackStateChange,
  onRequestNext,
  onTrackEnded
}: PlayerStackProps) {
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lyricLines = now.lyrics?.lines ?? EMPTY_LYRIC_LINES;
  const activeLyricIndex = useMemo(
    () => findActiveLyricIndex(lyricLines, audioTime * 1000),
    [audioTime, lyricLines]
  );

  useEffect(() => {
    setAudioTime(0);
    setAudioDuration(0);
  }, [now.track]);

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

  const onWsPayload = useCallback((payload: WsPayload) => {
    if (payload.event === "now_playing_updated") {
      setNow(payload.data as NowPlayingState);
    } else if (payload.event === "queue_updated") {
      setNow((current) => ({ ...current, queue: payload.data as NowPlayingState["queue"] }));
    } else if (payload.event === "dj_tts_ready") {
      const script = payload.data as NowPlayingState["djScript"];
      setNow((current) => (script ? { ...current, djScript: script } : { ...current }));
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
  }, []);

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
    setInput("");
    setChatError(null);
    setChatLoading(true);
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await sendChat(message);
      setMessages(response.messages);
      setNow(response.now);
      await refreshTaste();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "GPT DJ 暂时掉线了。");
      setMessages((current) => current.filter((item) => item !== optimistic));
    } finally {
      setChatLoading(false);
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
                "Neonwave is live. Describe a mood, a scene, or ask me to dissect the current track.",
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
              <span className="context-chip">女声</span>
            </div>
          </header>
          <MessageList
            chatLoading={chatLoading}
            messages={visibleMessages}
            onPlaySuggestion={onPlaySuggestion}
            suggestionLoadingId={suggestionLoadingId}
          />
          <p className="now-caption">Now playing: {trackTitle}</p>
          {now.djScript?.audioUrl ? <audio controls src={now.djScript.audioUrl} className="dj-audio" /> : null}
          <div className="chat-actions" aria-label="GPT DJ quick actions">
            <button type="button" onClick={() => void submitChat("点评当前这首")} disabled={chatLoading || !now.track}>
              点评当前
            </button>
            <button type="button" onClick={() => void submitChat("来点适合现在氛围的歌")} disabled={chatLoading}>
              氛围点歌
            </button>
          </div>
          {chatError ? <p className="chat-error">{chatError}</p> : null}
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
