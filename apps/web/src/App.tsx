import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { ChatMessage, NowPlayingState, SystemStatus, TasteProfile, WsPayload } from "@musicgpt/shared";
import {
  fetchChatHistory,
  fetchNowPlaying,
  fetchSystemStatus,
  fetchTaste,
  importFromNcm,
  requestNext,
  sendChat,
  sendFeedback
} from "./api";
import aiDjAvatarUrl from "./assets/ai-dj-avatar.svg";
import { useWsStream } from "./useWsStream";

const LYRIC_PREVIEW_LINES = [
  "City lights fold into the midnight radio",
  "A silver kick keeps time with your breathing",
  "We drift where the synth line opens wide",
  "Tell me the mood and I will tune the sky",
  "Every next song should feel like it found you",
  "Neonwave keeps the window warm tonight"
];

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

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0:00";
  }
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function App() {
  const [now, setNow] = useState<NowPlayingState>({ queue: [], paused: false });
  const [taste, setTaste] = useState<TasteProfile | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(() => new Date());
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const messageThreadRef = useRef<HTMLDivElement>(null);
  const currentTrackRef = useRef<NowPlayingState["track"]>(undefined);
  const advanceInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    const [nowState, tasteProfile, status, chatHistory] = await Promise.all([
      fetchNowPlaying(),
      fetchTaste(),
      fetchSystemStatus(),
      fetchChatHistory().catch(() => [])
    ]);
    setNow(nowState);
    setTaste(tasteProfile);
    setSystemStatus(status);
    setMessages(chatHistory);
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
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    currentTrackRef.current = now.track;
    setAudioTime(0);
    setAudioDuration(0);
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
      setSystemStatus(payload.data as SystemStatus);
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

  const onRequestNext = async (recordSkip = false) => {
    await runWithAdvanceLock(async () => {
      const currentTrack = currentTrackRef.current;
      if (recordSkip && currentTrack) {
        await sendFeedback({ type: "skip", trackId: currentTrack.id });
      }
      const response = await requestNext();
      setNow(response.now);
      await refreshTaste();
    });
  };

  const onTrackEnded = async () => {
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
  };

  const onFeedback = async (type: "skip" | "like" | "replay" | "complete") => {
    if (!now.track) {
      return;
    }
    await sendFeedback({ type, trackId: now.track.id });
    if (type === "skip") {
      await onRequestNext();
      return;
    }
    if (type === "replay" && audioRef.current) {
      audioRef.current.currentTime = 0;
      await audioRef.current.play().catch(() => undefined);
    }
    await refreshTaste();
  };

  const onTogglePlayback = async () => {
    if (!audioRef.current) {
      return;
    }
    if (playbackPaused) {
      try {
        await audioRef.current.play();
        setPlaybackPaused(false);
        setNow((current) => ({ ...current, paused: false }));
      } catch {
        setPlaybackPaused(true);
      }
      return;
    }
    audioRef.current.pause();
    setPlaybackPaused(true);
    setNow((current) => ({ ...current, paused: true }));
  };

  const onSeek = (value: number) => {
    if (!audioRef.current) {
      return;
    }
    audioRef.current.currentTime = value;
    setAudioTime(value);
  };

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

  const favoritePeriod = useMemo(
    () => taste?.favoritePeriods[0]?.period ?? "night",
    [taste?.favoritePeriods]
  );

  const trackTitle = now.track?.title ?? "等待开播";
  const artists = formatArtists(now.track?.artists);
  const isLive = Boolean(systemStatus?.ncmReachable);
  const queuePreview = now.queue.slice(0, 10);
  const nextTrack = now.queue[0]?.track;
  const activeLyricIndex = Math.min(
    LYRIC_PREVIEW_LINES.length - 1,
    Math.floor((audioTime / Math.max(audioDuration || 180, 1)) * LYRIC_PREVIEW_LINES.length)
  );
  const visibleMessages =
    messages.length > 0
      ? messages
      : [
          {
            role: "assistant" as const,
            text: now.djScript?.text ?? "Neonwave is live. Describe a mood, a scene, or ask me to dissect the current track.",
            at: new Date().toISOString()
          }
        ];

  useEffect(() => {
    const thread = messageThreadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }, [visibleMessages.length, chatLoading]);

  return (
    <main className="radio-shell">
      <div className="breathing-light" aria-hidden="true" />
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
        </nav>
      </header>

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

      <section className="console-grid" aria-label="Neonwave main console">
        <section className="player-stack" aria-label="Audio and lyrics">
          <article className="player-card">
            <header className="card-header">
              <div>
                <p className="micro-label">Now playing</p>
                <h2>{trackTitle}</h2>
              </div>
              <span className="status-chip">{playbackPaused ? "PAUSED" : "PLAYING"}</span>
            </header>
            <div className="player-body">
              <div className="cover-frame" aria-hidden="true">
                {now.track?.coverUrl ? <img alt="" src={now.track.coverUrl} /> : <span>NW</span>}
              </div>
              <div className="track-deck">
                <p className="artist-line">{artists}</p>
                <div className="equalizer" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="controls" aria-label="Playback controls">
                  <button type="button" aria-label="Replay" onClick={() => void onFeedback("replay")}>
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
                <p className="micro-label">Lyrics preview</p>
                <h2>Scrolling window</h2>
              </div>
              <span className="status-chip muted">UI ONLY</span>
            </header>
            <div className="lyrics-window">
              {LYRIC_PREVIEW_LINES.map((line, index) => (
                <p key={line} className={index === activeLyricIndex ? "active" : undefined}>
                  {line}
                </p>
              ))}
            </div>
          </article>
        </section>

        <article className="dj-console" aria-label="GPT DJ conversation">
          <header className="card-header">
            <div>
              <p className="micro-label">GPT DJ window</p>
              <h2>Conversation</h2>
            </div>
            <span className="context-chip">Context 8 turns</span>
          </header>
          <div className="message-thread" ref={messageThreadRef}>
            {visibleMessages.map((message, index) => (
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
                </div>
              </div>
            ))}
            {chatLoading ? (
              <div className="message-row assistant-row">
                <div className="avatar small dj-avatar" aria-hidden="true">
                  <img alt="" src={aiDjAvatarUrl} />
                </div>
                <div className="message-bubble is-thinking">
                  <p>GPT DJ 正在翻箱倒柜地找那首最像你的歌...</p>
                </div>
              </div>
            ) : null}
          </div>
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
        <span>{systemStatus?.aiDjConfigured ? `AI ${systemStatus.aiDjModel ?? "ONLINE"}` : "AI FALLBACK"}</span>
        <span>Taste {favoritePeriod}</span>
        <span>Import {formatTime(systemStatus?.lastImportAt)}</span>
        {systemStatus?.aiDjLastError ? <span className="error-text">AI {systemStatus.aiDjLastError}</span> : null}
        {systemStatus?.lastImportError ? <span className="error-text">{systemStatus.lastImportError}</span> : null}
        {importError ? <span className="error-text">{importError}</span> : null}
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
