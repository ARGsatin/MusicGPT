import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { NowPlayingState, TrackLyrics } from "@musicgpt/shared";
import { findActiveLyricIndex } from "../lyrics";
import { LyricsOverlay } from "./LyricsOverlay";
import {
  applyPlayerVolume,
  DEFAULT_PLAYER_VOLUME,
  fadePlayerVolume,
  loadPlayerVolume,
  normalizeVolumeLevel,
  savePlayerVolume
} from "../volume";
import { getDuckedPlayerVolume, SPEECH_DUCKING_FADE_MS } from "../speech";

interface TurntableStageProps {
  now: NowPlayingState;
  onFeedback: (type: "skip" | "like" | "replay" | "complete") => Promise<void>;
  onFavorite: (favorite: boolean) => Promise<void>;
  onPlaybackStateChange: (paused: boolean) => void;
  onRequestNext: (recordSkip?: boolean) => Promise<void>;
  onTrackEnded: () => Promise<void>;
  speechActive: boolean;
}

function formatArtists(artists: string[] | undefined): string {
  if (!artists || artists.length === 0) {
    return "未知艺术家";
  }
  return artists.join(" / ");
}

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
const RING_RADIUS = 158;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 唱机下方悬浮的卡拉 OK 歌词条：前一行淡出、当前行高亮、下一行预告。有歌词时可点击展开全屏歌词。 */
const LyricRibbon = memo(function LyricRibbon({
  activeIndex,
  lyrics,
  onExpand
}: {
  activeIndex: number;
  lyrics: TrackLyrics | undefined;
  onExpand?: (() => void) | undefined;
}) {
  const lines = lyrics?.lines ?? EMPTY_LYRIC_LINES;
  const current = activeIndex >= 0 ? lines[activeIndex] : undefined;
  const upcoming = activeIndex >= 0 ? lines[activeIndex + 1] : lines[0];

  if (lyrics?.pureMusic) {
    return (
      <div className="lyric-ribbon" aria-live="polite">
        <p className="lyric-now">纯音乐，请沉浸欣赏</p>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="lyric-ribbon" aria-live="polite">
        <p className="lyric-now is-idle">等待歌词信号…</p>
      </div>
    );
  }

  const content = (
    <>
      <p className="lyric-now" key={`${activeIndex}-${current?.timeMs ?? 0}`}>
        {current?.text ?? "♪"}
        {current?.translation ? <span className="lyric-translation">{current.translation}</span> : null}
      </p>
      {upcoming ? <p className="lyric-next">{upcoming.text}</p> : null}
    </>
  );

  if (!onExpand) {
    return (
      <div className="lyric-ribbon" aria-live="polite">
        {content}
      </div>
    );
  }

  return (
    <button
      className="lyric-ribbon is-expandable"
      type="button"
      aria-label="展开全部歌词"
      title="展开全部歌词"
      aria-live="polite"
      onClick={onExpand}
    >
      {content}
      <span className="lyric-expand-hint" aria-hidden="true">
        全部歌词 ⤢
      </span>
    </button>
  );
});

export const TurntableStage = memo(function TurntableStage({
  now,
  onFeedback,
  onFavorite,
  onPlaybackStateChange,
  onRequestNext,
  onTrackEnded,
  speechActive
}: TurntableStageProps) {
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [favorite, setFavorite] = useState(Boolean(now.isFavorite));
  const [favoritePending, setFavoritePending] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [heartBurst, setHeartBurst] = useState(0);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [playerVolume, setPlayerVolume] = useState(() => loadPlayerVolume(getBrowserStorage()));
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastAudibleVolumeRef = useRef(
    playerVolume.level > 0 ? playerVolume.level : DEFAULT_PLAYER_VOLUME.level
  );
  const previousSpeechActiveRef = useRef(speechActive);
  const lyricLines = now.lyrics?.lines ?? EMPTY_LYRIC_LINES;
  const activeLyricIndex = useMemo(
    () => findActiveLyricIndex(lyricLines, audioTime * 1000),
    [audioTime, lyricLines]
  );

  useEffect(() => {
    setAudioTime(0);
    setAudioDuration(0);
    setFavorite(Boolean(now.isFavorite));
    setFavoriteError(null);
    setLyricsOpen(false);
  }, [now.track]);

  useEffect(() => {
    setFavorite(Boolean(now.isFavorite));
  }, [now.isFavorite]);

  useEffect(() => {
    const audio = audioRef.current;
    const speechStateChanged = previousSpeechActiveRef.current !== speechActive;
    previousSpeechActiveRef.current = speechActive;
    let cancelFade: (() => void) | undefined;
    if (audio) {
      const targetVolume = getDuckedPlayerVolume(playerVolume, speechActive);
      if (speechStateChanged) {
        cancelFade = fadePlayerVolume(audio, targetVolume, SPEECH_DUCKING_FADE_MS);
      } else {
        applyPlayerVolume(audio, targetVolume);
      }
    }
    savePlayerVolume(getBrowserStorage(), playerVolume);
    return cancelFade;
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

  const onToggleFavorite = async () => {
    if (!now.track || favoritePending) {
      return;
    }
    const nextFavorite = !favorite;
    setFavorite(nextFavorite);
    setHeartBurst((burst) => burst + 1);
    setFavoritePending(true);
    setFavoriteError(null);
    try {
      await onFavorite(nextFavorite);
    } catch {
      setFavorite(!nextFavorite);
      setFavoriteError("收藏失败，请稍后重试");
    } finally {
      setFavoritePending(false);
    }
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
  const progress = audioDuration > 0 ? Math.min(1, audioTime / audioDuration) : 0;
  const isPlaying = !playbackPaused;

  return (
    <section className="stage" aria-label="Turntable stage">
      <div className="turntable-wrap">
        <div className={isPlaying ? "turntable is-playing" : "turntable"}>
          <svg className="progress-ring" viewBox="0 0 340 340" aria-hidden="true">
            <circle className="ring-track" cx="170" cy="170" r={RING_RADIUS} />
            <circle
              className="ring-fill"
              cx="170"
              cy="170"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress)}
            />
          </svg>

          <button
            className="platter"
            type="button"
            onClick={() => void onTogglePlayback()}
            aria-label={playbackPaused ? "播放" : "暂停"}
          >
            <div className={isPlaying ? "vinyl is-spinning" : "vinyl"}>
              <div className="vinyl-grooves" />
              <div className="vinyl-label">
                {now.track?.coverUrl ? <img alt="" src={now.track.coverUrl} /> : <span>MG</span>}
              </div>
              <i className="vinyl-spindle" />
            </div>
            <span className="platter-hint" aria-hidden="true">
              {playbackPaused ? "▶" : "❚❚"}
            </span>
          </button>

          <div className={isPlaying ? "tonearm is-down" : "tonearm"} aria-hidden="true">
            <i className="tonearm-pivot" />
            <i className="tonearm-rod" />
            <i className="tonearm-head" />
          </div>

          <span className={isPlaying ? "stylus-light is-on" : "stylus-light"} aria-hidden="true" />
        </div>
      </div>

      <div className="stage-meta">
        <p className="micro-label">NOW SPINNING</p>
        <h1 className="stage-title">{now.track?.title ?? "等待开播"}</h1>
        <p className="stage-artist">{formatArtists(now.track?.artists)}</p>
        <div className={isPlaying ? "equalizer is-live" : "equalizer"} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>

      <LyricRibbon
        activeIndex={activeLyricIndex}
        lyrics={now.lyrics}
        onExpand={lyricLines.length > 0 ? () => setLyricsOpen(true) : undefined}
      />

      {lyricsOpen && now.lyrics && lyricLines.length > 0 ? (
        <LyricsOverlay
          activeIndex={activeLyricIndex}
          artist={formatArtists(now.track?.artists)}
          lyrics={now.lyrics}
          trackTitle={now.track?.title ?? "等待开播"}
          onClose={() => setLyricsOpen(false)}
          onSeek={onSeek}
        />
      ) : null}

      <div className="transport" aria-label="Playback controls">
        <button className="transport-btn" type="button" aria-label="Replay" onClick={() => void onReplay()}>
          <span aria-hidden="true">↺</span>
        </button>
        <button
          className="transport-btn transport-primary"
          type="button"
          aria-label="Play or pause"
          onClick={() => void onTogglePlayback()}
        >
          <span aria-hidden="true">{playbackPaused ? "▶" : "❚❚"}</span>
        </button>
        <button className="transport-btn" type="button" aria-label="Next" onClick={() => void onRequestNext(true)}>
          <span aria-hidden="true">⇥</span>
        </button>
        <button
          className={favorite ? "transport-btn transport-favorite is-active" : "transport-btn transport-favorite"}
          type="button"
          aria-label={favorite ? "取消收藏" : "收藏当前歌曲"}
          aria-pressed={favorite}
          disabled={!now.track || favoritePending}
          onClick={() => void onToggleFavorite()}
        >
          <span key={heartBurst} className={heartBurst > 0 ? "heart-burst" : undefined} aria-hidden="true">
            {favoritePending ? "…" : favorite ? "♥" : "♡"}
          </span>
        </button>
      </div>
      {favoriteError ? (
        <p className="favorite-error" role="status">
          {favoriteError}
        </p>
      ) : null}

      <div className="seek-row">
        <span className="timecode">{formatDuration(audioTime)}</span>
        <input
          type="range"
          min={0}
          max={audioDuration || 0}
          value={Math.min(audioTime, audioDuration || 0)}
          step={1}
          onChange={(event) => onSeek(Number(event.currentTarget.value))}
          aria-label="Seek current track"
        />
        <span className="timecode">{formatDuration(audioDuration)}</span>
      </div>

      <div className="volume-row">
        <button
          className="volume-button"
          type="button"
          aria-label={volumeMuted ? "Unmute" : "Mute"}
          aria-pressed={volumeMuted}
          onClick={onToggleMute}
        >
          <span aria-hidden="true">{volumeMuted ? "🔇" : "🔊"}</span>
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
    </section>
  );
});
