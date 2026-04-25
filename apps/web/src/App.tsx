import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { NowPlayingState, SystemStatus, TasteProfile, WsPayload } from "@musicgpt/shared";
import {
  fetchNowPlaying,
  fetchSystemStatus,
  fetchTaste,
  importFromNcm,
  requestNext,
  sendChat,
  sendFeedback
} from "./api";
import { useWsStream } from "./useWsStream";

function formatArtists(artists: string[] | undefined): string {
  if (!artists || artists.length === 0) {
    return "未知艺术家";
  }
  return artists.join(" / ");
}

export default function App() {
  const [now, setNow] = useState<NowPlayingState>({ queue: [], paused: false });
  const [taste, setTaste] = useState<TasteProfile | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [input, setInput] = useState("");
  const [assistantText, setAssistantText] = useState("我准备好给你播歌了。");
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTrackRef = useRef<NowPlayingState["track"]>(undefined);
  const advanceInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    const [nowState, tasteProfile, status] = await Promise.all([
      fetchNowPlaying(),
      fetchTaste(),
      fetchSystemStatus()
    ]);
    setNow(nowState);
    setTaste(tasteProfile);
    setSystemStatus(status);
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
      setSystemStatus(payload.data as SystemStatus);
    }
  }, []);

  useWsStream(onWsPayload);

  const onSubmitChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim()) {
      return;
    }
    const message = input.trim();
    setInput("");
    const response = await sendChat(message);
    setAssistantText(response.reply);
    setNow(response.now);
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
    () => taste?.favoritePeriods[0]?.period ?? "evening",
    [taste?.favoritePeriods]
  );

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">MusicGPT • 私人电台</p>
        <h1>真正懂你的 AI 音乐电台</h1>
        <p className="subtitle">
          自动续播、实时学习你的口味、必要时轻声播报。当前偏好时段: {favoritePeriod}
        </p>
      </section>

      <section className="panel system-panel">
        <header>
          <h2>运行状态</h2>
          <button onClick={() => void onImportNcm()} type="button" disabled={importing}>
            {importing ? "导入中..." : "重新导入网易云数据"}
          </button>
        </header>
        <p className="subtitle">
          运行目录: {systemStatus?.runningRoot ?? "未知"} · NCM:
          {systemStatus?.ncmReachable ? " 已连接" : " 未连接"}
        </p>
        <p className="subtitle">
          曲库条数: {systemStatus?.trackStatsCount ?? 0} · 当前队列: {systemStatus?.queueLength ?? 0}
        </p>
        {systemStatus?.lastImportAt ? (
          <p className="subtitle">最近导入时间: {new Date(systemStatus.lastImportAt).toLocaleString()}</p>
        ) : null}
        {systemStatus?.lastImportError ? (
          <p className="error-text">最近导入异常: {systemStatus.lastImportError}</p>
        ) : null}
        {importError ? <p className="error-text">{importError}</p> : null}
      </section>

      <section className="grid">
        <article className="panel player-panel">
          <header>
            <h2>Now Playing</h2>
            <button className="ghost" onClick={() => void onRequestNext(true)} type="button">
              下一首
            </button>
          </header>
          {loading ? <p>加载中...</p> : null}
          <div className="now-track">
            <div className="cover">
              {now.track?.coverUrl ? (
                <img alt={now.track.title} src={now.track.coverUrl} />
              ) : (
                <span>{now.track ? now.track.title.slice(0, 1) : "M"}</span>
              )}
            </div>
            <div>
              <h3>{now.track?.title ?? "等待开播"}</h3>
              <p>{formatArtists(now.track?.artists)}</p>
            </div>
          </div>
          <audio
            ref={audioRef}
            controls
            autoPlay
            src={now.track?.songUrl}
            onEnded={() => void onTrackEnded()}
            className="audio"
          />
          <div className="actions">
            <button onClick={() => void onFeedback("like")} type="button">
              收藏
            </button>
            <button onClick={() => void onFeedback("skip")} type="button">
              跳过
            </button>
            <button onClick={() => void onFeedback("replay")} type="button">
              重播
            </button>
          </div>
          <div className="queue">
            <h4>接下来（10 首窗口规划）</h4>
            <ol>
              {now.queue.slice(0, 10).map((item) => (
                <li key={item.track.id}>
                  <strong>{item.track.title}</strong>
                  <span>{formatArtists(item.track.artists)}</span>
                </li>
              ))}
            </ol>
          </div>
        </article>

        <article className="panel chat-panel">
          <header>
            <h2>AI 电台对话</h2>
          </header>
          <p className="assistant">{assistantText}</p>
          <form onSubmit={onSubmitChat} className="chat-form">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="比如：来点夜晚氛围、播放周杰伦、切歌"
            />
            <button type="submit">发送</button>
          </form>
          <div className="dj-card">
            <h4>DJ 播报</h4>
            <p>{now.djScript?.text ?? "默认每 4 首自动播报一次。"}</p>
            {now.djScript?.audioUrl ? (
              <audio controls src={now.djScript.audioUrl} className="audio" />
            ) : null}
          </div>
        </article>

        <article className="panel profile-panel">
          <header>
            <h2>你的音乐画像</h2>
          </header>
          <p>{taste?.summary ?? "先听几首，我会逐渐学会你的偏好。"}</p>
          <h4>高频艺人</h4>
          <ul className="chips">
            {(taste?.topArtists ?? []).slice(0, 6).map((artist) => (
              <li key={artist.name}>
                {artist.name} · {Math.round(artist.weight * 100)}%
              </li>
            ))}
          </ul>
          <h4>常听时段</h4>
          <ul className="bars">
            {(taste?.favoritePeriods ?? []).map((period) => (
              <li key={period.period}>
                <span>{period.period}</span>
                <progress value={period.weight} max={1} />
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
