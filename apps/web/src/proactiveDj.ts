const EARLY_SKIP_WINDOW_MS = 10 * 60_000;
export const PROACTIVE_COOLDOWN_MS = 20 * 60_000;
export const EARLY_SKIP_REMINDER = "10 分钟内已经连续两次很早切歌，我会重新评估当前方向；如有更合适的选择，只调整未播放的后续队列。";

export function canShowProactiveReminder(
  lastShownAt: number,
  now: number,
  bypassCooldown: boolean
): boolean {
  return bypassCooldown || now - lastShownAt >= PROACTIVE_COOLDOWN_MS;
}

export function registerEarlySkip(
  history: number[],
  at: number,
  listenedMs: number,
  durationMs?: number
): { times: number[]; trigger: boolean } {
  const early = listenedMs <= 30_000 ||
    (durationMs !== undefined && durationMs > 0 && listenedMs / durationMs < 0.2);
  if (!early) return { times: history.filter((time) => at - time <= EARLY_SKIP_WINDOW_MS), trigger: false };
  const times = [...history, at].filter((time) => at - time <= EARLY_SKIP_WINDOW_MS);
  return { times, trigger: times.length >= 2 };
}
