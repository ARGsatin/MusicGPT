import { memo, useEffect, useState } from "react";

import aiDjAvatarUrl from "../assets/ai-dj-avatar.svg";

interface StatusRibbonProps {
  importing: boolean;
  isLive: boolean;
  recommendationLoading: boolean;
  weatherLoading: boolean;
  onImportNcm: () => void;
  onImportRecommendations: () => void;
  onSyncWeather: () => void;
}

function formatClock(now: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now);
}

function formatDate(now: Date): string {
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
  const month = new Intl.DateTimeFormat("zh-CN", { month: "long" }).format(now);
  const day = new Intl.DateTimeFormat("zh-CN", { day: "numeric" }).format(now);
  return `${month}${day} · ${weekday}`;
}

const StationClock = memo(function StationClock() {
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="ribbon-clock" aria-label="电台时间">
      <strong>{formatClock(clock)}</strong>
      <span>{formatDate(clock)}</span>
    </div>
  );
});

export const StatusRibbon = memo(function StatusRibbon({
  importing,
  isLive,
  recommendationLoading,
  weatherLoading,
  onImportNcm,
  onImportRecommendations,
  onSyncWeather
}: StatusRibbonProps) {
  return (
    <header className="status-ribbon" aria-label="电台顶部栏">
      <div className="ribbon-brand">
        <span className="ribbon-avatar" aria-hidden="true">
          <img alt="" src={aiDjAvatarUrl} />
        </span>
        <div className="ribbon-wordmark">
          <strong>拾光电台</strong>
          <span>AURORA DECK</span>
        </div>
        <span className={isLive ? "onair-badge is-live" : "onair-badge"}>
          <i aria-hidden="true" />
          {isLive ? "ON AIR" : "LOCAL"}
        </span>
      </div>

      <StationClock />

      <nav className="ribbon-actions" aria-label="电台操作">
        <button className="ribbon-pill" type="button" onClick={onImportNcm} disabled={importing}>
          {importing ? "同步中…" : "同步收藏"}
        </button>
        <button className="ribbon-pill" type="button" onClick={onSyncWeather} disabled={weatherLoading}>
          {weatherLoading ? "定位中…" : "天气感应"}
        </button>
        <button className="ribbon-pill" type="button" onClick={onImportRecommendations} disabled={recommendationLoading}>
          {recommendationLoading ? "扩展中…" : "扩充曲库"}
        </button>
      </nav>
    </header>
  );
});

interface SignalTickerProps {
  items: string[];
  errors: string[];
}

/** 底部信号跑马灯：把系统状态、口味标签、天气等串成电台字幕带。 */
export const SignalTicker = memo(function SignalTicker({ items, errors }: SignalTickerProps) {
  const segments = [...items, ...errors];
  if (segments.length === 0) {
    return null;
  }
  const line = segments.join("  ✦  ");
  return (
    <footer className="signal-ticker" aria-label="电台信号状态">
      <div className="ticker-track" aria-hidden="true">
        <span>{line}</span>
        <span>{line}</span>
      </div>
      <ul className="ticker-static">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
        {errors.map((item) => (
          <li key={item} className="ticker-error">
            {item}
          </li>
        ))}
      </ul>
    </footer>
  );
});
