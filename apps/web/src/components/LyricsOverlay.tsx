import { memo, useEffect, useRef } from "react";

import type { TrackLyrics } from "@musicgpt/shared";

interface LyricsOverlayProps {
  activeIndex: number;
  artist: string;
  lyrics: TrackLyrics;
  trackTitle: string;
  onClose: () => void;
  onSeek: (seconds: number) => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 全屏卡拉 OK 歌词面板：当前行高亮并自动居中滚动，
 * 点击任意一句直接跳转到对应播放进度。
 */
export const LyricsOverlay = memo(function LyricsOverlay({
  activeIndex,
  artist,
  lyrics,
  trackTitle,
  onClose,
  onSeek
}: LyricsOverlayProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth"
    });
  }, [activeIndex]);

  return (
    <div className="lyrics-overlay" role="dialog" aria-modal="true" aria-label="全部歌词">
      <button className="lyrics-backdrop" type="button" aria-label="关闭歌词" onClick={onClose} />
      <div className="lyrics-panel">
        <header className="lyrics-panel-header">
          <div className="lyrics-panel-title">
            <strong>{trackTitle}</strong>
            <span>{artist}</span>
          </div>
          <button className="lyrics-close" type="button" aria-label="关闭歌词" onClick={onClose}>
            ✕
          </button>
        </header>

        {lyrics.pureMusic ? (
          <div className="lyrics-empty">
            <span aria-hidden="true">🎻</span>
            <p>纯音乐，请沉浸欣赏</p>
          </div>
        ) : (
          <div className="lyrics-scroll" ref={listRef}>
            {lyrics.lines.map((line, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={`${line.timeMs}-${index}`}
                  ref={isActive ? activeLineRef : undefined}
                  className={isActive ? "lyrics-line is-active" : "lyrics-line"}
                  type="button"
                  aria-label={`跳转到 ${line.text}`}
                  aria-current={isActive}
                  onClick={() => onSeek(line.timeMs / 1000)}
                >
                  <span className="lyrics-line-text">{line.text || "♪"}</span>
                  {line.translation ? <span className="lyrics-line-translation">{line.translation}</span> : null}
                </button>
              );
            })}
          </div>
        )}

        <p className="lyrics-panel-hint">点击任意一句跳转进度 · Esc 关闭</p>
      </div>
    </div>
  );
});
