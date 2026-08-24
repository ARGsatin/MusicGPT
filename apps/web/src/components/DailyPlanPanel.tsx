import { useCallback, useEffect, useState } from "react";

import type {
  DailyPlan,
  DayPeriod,
  MusicSource,
  MusicSourceStatus,
  QqAuthQrResponse,
  SystemStatus
} from "@musicgpt/shared";

import {
  createQqAuthQr,
  disconnectQqMusic,
  fetchDailyPlan,
  fetchMusicSources,
  fetchSystemStatus,
  pollQqAuthQr,
  playCurrentDailyPlanSegment,
  regenerateDailyPlan,
  syncMusicSource
} from "../api";

const PERIOD_LABELS: Record<DayPeriod, string> = {
  morning: "晨间探索",
  afternoon: "午后柔和",
  evening: "晚间回忆",
  late_night: "深夜"
};

export function DailyPlanPanel() {
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [sources, setSources] = useState<MusicSourceStatus[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [qr, setQr] = useState<QqAuthQrResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextPlan, nextSources, nextStatus] = await Promise.all([
      fetchDailyPlan().catch(() => null),
      fetchMusicSources().catch(() => []),
      fetchSystemStatus().catch(() => null)
    ]);
    setPlan(nextPlan);
    setSources(nextSources);
    setSystemStatus(nextStatus);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!qr) return;
    const poll = async () => {
      try {
        const status = await pollQqAuthQr(qr.sessionId);
        if (status.status === "authorized") {
          setQr(null);
          await refresh();
        } else if (status.status === "expired" || status.status === "error") {
          setQr(null);
          setError(status.message ?? "QQ 音乐二维码已失效，请重试。");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "QQ 登录状态读取失败。");
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    void poll();
    return () => window.clearInterval(timer);
  }, [qr, refresh]);

  const run = async (key: string, job: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await job();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  const qq = sources.find((source) => source.source === "qq");
  return (
    <div className="daily-plan-panel">
      <section className="source-connectors" aria-label="音乐曲源">
        <div className="source-heading">
          <div>
            <span>双曲源</span>
            <strong>网易云 + QQ 音乐</strong>
          </div>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run("plan", async () => setPlan(await regenerateDailyPlan()))}
          >
            {busy === "plan" ? "重排中" : "重排全天计划"}
          </button>
        </div>
        <div className="source-grid">
          {sources.map((source) => (
            <article className={source.connected ? "source-card is-connected" : "source-card"} key={source.source}>
              <span className={`source-badge source-${source.source}`}>{source.source === "qq" ? "QQ" : "网易云"}</span>
              <strong>{source.accountLabel ?? (source.connected ? "已连接" : "未连接")}</strong>
              <small>{source.lastSyncAt ? `同步于 ${new Date(source.lastSyncAt).toLocaleString("zh-CN")}` : "尚未同步"}</small>
              {source.connected ? (
                <div className="source-actions">
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void run(`${source.source}-sync`, async () => { await syncMusicSource(source.source as MusicSource); })}
                  >
                    {busy === `${source.source}-sync` ? "同步中" : "立即同步"}
                  </button>
                  {source.source === "qq" ? (
                    <button
                      className="source-disconnect"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => void run("qq-disconnect", disconnectQqMusic)}
                    >
                      断开
                    </button>
                  ) : null}
                </div>
              ) : source.source === "qq" ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run("qq-qr", async () => setQr(await createQqAuthQr()))}
                >
                  {busy === "qq-qr" ? "生成中" : "扫码连接"}
                </button>
              ) : null}
            </article>
          ))}
          {sources.length === 0 ? <p className="plan-empty">曲源状态暂不可用。</p> : null}
        </div>
        {qr && !qq?.connected ? (
          <div className="qq-qr-card">
            <img src={qr.imageDataUrl} alt="QQ 音乐登录二维码" />
            <div>
              <strong>用 QQ 音乐扫码</strong>
              <p>二维码只在本机服务端会话中使用；Cookie 不会发送到页面。</p>
              <small>有效至 {new Date(qr.expiresAt).toLocaleTimeString("zh-CN")}</small>
            </div>
          </div>
        ) : null}
      </section>

      <section className="routine-status">
        <span className={systemStatus?.routineDocument?.valid ? "status-dot is-ok" : "status-dot"} />
        <div>
          <strong>Routine {systemStatus?.routineDocument?.valid ? "已解析" : "使用最后有效版本"}</strong>
          <small>{systemStatus?.routineDocument?.path ?? "state/routine.json"}</small>
          {systemStatus?.routineDocument?.error ? <em>{systemStatus.routineDocument.error}</em> : null}
        </div>
      </section>

      <section className="plan-playback" aria-label="今日计划播放">
        <div>
          <span>今日计划</span>
          <strong>从当前时段开始播放</strong>
          <small>立即切换播放器，并按该时段的推荐顺序继续播放。</small>
        </div>
        <button
          type="button"
          aria-label="一键播放当前时段歌单"
          disabled={Boolean(busy) || !plan}
          onClick={() => void run("play-plan", async () => {
            const result = await playCurrentDailyPlanSegment();
            const title = result.now.track?.title;
            setNotice(`已切换到${PERIOD_LABELS[result.period]}歌单${title ? `，正在播放《${title}》` : ""}`);
          })}
        >
          {busy === "play-plan" ? "正在切换…" : "▶ 一键播放当前时段"}
        </button>
      </section>

      {error ? <p className="plan-error">{error}</p> : null}
      {notice ? <p className="plan-success" role="status">{notice}</p> : null}
      {plan ? <DailyPlanSegments plan={plan} /> : (
        <section className="plan-segments" aria-label="今日音乐计划">
          <p className="plan-empty">全天计划正在生成。</p>
        </section>
      )}
    </div>
  );
}

export function DailyPlanSegments({ plan }: { plan: DailyPlan }) {
  return (
    <section className="plan-segments" aria-label="今日音乐计划">
      {plan.segments.map((segment) => (
        <article className="plan-segment" key={segment.period}>
          <header>
            <div>
              <span>{PERIOD_LABELS[segment.period]}</span>
              <strong>{periodRange(segment.start, segment.end, plan.timezone)}</strong>
            </div>
            <small>{segment.items.length === 0
              ? "暂无可播放歌曲"
              : `约 ${Math.round(segment.targetDurationMs / 60_000)} 分钟 · ${segment.items.length} 首`}</small>
          </header>
          {segment.routine.length > 0 ? (
            <p className="segment-context">{segment.routine.map((block) => block.activity).join(" / ")} · {weatherName(segment.weather)}</p>
          ) : <p className="segment-context">{weatherName(segment.weather)}</p>}
          <ol>
            {segment.items.map((item) => (
              <li key={item.track.trackKey ?? item.track.id}>
                <span className={`source-dot source-${item.track.source ?? "ncm"}`}>{item.track.source === "qq" ? "Q" : "N"}</span>
                <span><strong>{item.track.title}</strong><small>{item.track.artists.join(" / ")} · {item.reason}</small></span>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}

function periodRange(start: string, end: string, timezone: string): string {
  const startTime = planTime(start, timezone);
  const rawEndTime = planTime(end, timezone);
  const endTime = rawEndTime === "00:00" && Date.parse(end) > Date.parse(start)
    ? "24:00"
    : rawEndTime;
  return `${startTime}–${endTime}`;
}

function planTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function weatherName(weather: string): string {
  return ({ clear: "晴", cloudy: "多云", rain: "雨", snow: "雪", fog: "雾", storm: "风暴", unknown: "天气待更新" } as Record<string, string>)[weather] ?? weather;
}
