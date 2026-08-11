import { memo } from "react";

import type { WeatherKind } from "@musicgpt/shared";

interface AmbientBackdropProps {
  weather: WeatherKind | undefined;
}

/**
 * 极光氛围背景：三层缓慢漂移的极光光带 + 漂浮微尘。
 * 颜色由天气驱动（通过父级 .deck 上的 weather-* class 控制 CSS 变量）。
 */
export const AmbientBackdrop = memo(function AmbientBackdrop({ weather }: AmbientBackdropProps) {
  return (
    <div className="aurora-backdrop" data-weather={weather ?? "unknown"} aria-hidden="true">
      <div className="aurora-band band-a" />
      <div className="aurora-band band-b" />
      <div className="aurora-band band-c" />
      <div className="aurora-dust">
        {Array.from({ length: 18 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <div className="aurora-grain" />
    </div>
  );
});
