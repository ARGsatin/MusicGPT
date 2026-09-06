import { memo } from "react";

import type {
  FeedbackReason,
  IntelligencePolicyStatus,
  LearningReceipt,
  RecommendationDecision,
  TasteResponse,
  TasteSignal,
  TasteSignalMutationAction
} from "@musicgpt/shared";
import type { PendingMusicClarification } from "../musicClarification";

const FEEDBACK_CHOICES: Array<{ reason: FeedbackReason; label: string }> = [
  { reason: "dislike_track", label: "不喜欢这首" },
  { reason: "wrong_for_now", label: "现在不合适" },
  { reason: "overplayed", label: "听腻了" },
  { reason: "less_this_artist", label: "少放这个艺人" },
  { reason: "bad_version", label: "版本有问题" }
];

export const WhyThisTrack = memo(function WhyThisTrack({
  decision
}: {
  decision: RecommendationDecision | undefined;
}) {
  const evidence = decision?.evidence.slice(0, 3) ?? [];
  return (
    <details className="recommendation-explanation">
      <summary>为什么放这首</summary>
      {evidence.length > 0 ? (
        <ul>
          {evidence.map((item, index) => (
            <li key={`${item.signalId ?? item.type}-${index}`}>
              <span>{item.label}</span>
              {item.correctable ? <small>可纠正</small> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>这首来自当前队列；新的排序证据会在下次决策后显示。</p>
      )}
    </details>
  );
});

export const ExplicitFeedbackControls = memo(function ExplicitFeedbackControls({
  disabled,
  onFeedback
}: {
  disabled: boolean;
  onFeedback: (reason: FeedbackReason) => void;
}) {
  return (
    <div className="teaching-controls" aria-label="纠正推荐">
      {FEEDBACK_CHOICES.map((choice) => (
        <button
          type="button"
          disabled={disabled}
          key={choice.reason}
          onClick={() => onFeedback(choice.reason)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
});

export const LearningReceiptNotice = memo(function LearningReceiptNotice({
  busy,
  receipt,
  onDismiss,
  onUndo
}: {
  busy: boolean;
  receipt: LearningReceipt;
  onDismiss: () => void;
  onUndo: () => void;
}) {
  const undoAvailable = receipt.changedSignals.length > 0
    && Date.parse(receipt.undoExpiresAt) > Date.now();
  const shadowOnly = receipt.appliedMode === "shadow_only";
  const legacyOnly = receipt.appliedMode === "legacy_only";
  const undone = /^已撤销/u.test(receipt.summary.trim());
  return (
    <section className="learning-receipt" aria-live="polite" aria-label="学习回执">
      <div>
        <strong>{undone ? "已撤销这次学习" : shadowOnly ? "已记录，正在影子验证" : legacyOnly ? "已记录，当前使用旧策略" : "已经学到"}</strong>
        <p>{undone ? receipt.summary : shadowOnly ? "这次纠正已进入新策略评估；当前仍由原排序负责播放。" : legacyOnly ? "这次纠正已保存；legacy 模式不会使用新画像排序。" : receipt.summary}</p>
        <small>
          {scopeLabel(receipt.scope)}
          {undone && shadowOnly
            ? receipt.replacedQueueCount > 0
              ? ` · 新策略画像已恢复；既有排序同步调整 ${receipt.replacedQueueCount} 首`
              : " · 新策略画像已恢复，当前队列未变化"
            : shadowOnly
            ? receipt.replacedQueueCount > 0
              ? ` · 新策略尚未接管；既有排序已实际替换 ${receipt.replacedQueueCount} 首`
              : " · 新策略尚未接管，当前队列未变化"
            : legacyOnly
              ? receipt.replacedQueueCount > 0
                ? ` · 旧策略已实际替换 ${receipt.replacedQueueCount} 首`
                : " · 旧策略队列未变化"
            : receipt.replacedQueueCount > 0
              ? ` · 后续队列替换 ${receipt.replacedQueueCount} 首`
              : " · 当前曲目保持不变"}
        </small>
      </div>
      <div className="learning-receipt-actions">
        {undoAvailable ? (
          <button type="button" disabled={busy} onClick={onUndo}>{busy ? "撤销中…" : "撤销"}</button>
        ) : null}
        <button type="button" aria-label="关闭学习回执" onClick={onDismiss}>×</button>
      </div>
    </section>
  );
});

export const MusicClarificationCard = memo(function MusicClarificationCard({
  busy,
  clarification,
  error,
  onCancel,
  onSelect
}: {
  busy: boolean;
  clarification: PendingMusicClarification;
  error: string | null;
  onCancel: () => void;
  onSelect: (track: PendingMusicClarification["candidates"][number]) => void;
}) {
  return (
    <section className="music-clarification-card" aria-live="polite" aria-label="确认要播放的歌曲">
      <header>
        <div><span>需要确认</span><strong>{clarification.question}</strong></div>
        <button type="button" aria-label="取消点歌确认" onClick={onCancel}>×</button>
      </header>
      <div className="clarification-candidates">
        {clarification.candidates.slice(0, 6).map((track) => {
          const reference = track.trackKey ?? track.id;
          return (
            <button type="button" disabled={busy} key={String(reference)} onClick={() => onSelect(track)}>
              <span className="clarification-cover" aria-hidden="true">
                {track.coverUrl ? <img alt="" src={track.coverUrl} /> : "♪"}
              </span>
              <span><strong>{track.title}</strong><small>{track.artists.join(" / ")}</small></span>
              <em>{busy ? "确认中…" : "确认播放"}</em>
            </button>
          );
        })}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
});

export type TasteSignalAction = TasteSignalMutationAction;

export const MusicTastePanel = memo(function MusicTastePanel({
  taste,
  onSignalAction
}: {
  taste: TasteResponse | null;
  onSignalAction: (signal: TasteSignal | undefined, action: TasteSignalAction) => void;
}) {
  if (!taste) {
    return <div className="music-profile-panel"><p className="profile-empty">音乐画像正在整理。</p></div>;
  }
  const groups: Array<{ key: keyof NonNullable<TasteResponse["signals"]>; label: string }> = [
    { key: "explicit", label: "明确告诉我的" },
    { key: "implicit", label: "达到阈值的听播习惯" },
    { key: "legacy", label: "旧数据基线" }
  ];
  const manualLabels = [
    ...Object.entries(taste.manualRules.artistWeights).map(([artist, weight]) => `${artist} ${weight > 0 ? "+" : ""}${weight}`),
    ...Object.entries(taste.manualRules.tagWeights).map(([tag, weight]) => `#${tag} ${weight > 0 ? "+" : ""}${weight}`),
    ...taste.manualRules.blockedArtists.map((artist) => `屏蔽艺人：${artist}`),
    ...taste.manualRules.blockedTags.map((tag) => `屏蔽标签：#${tag}`)
  ];

  return (
    <div className="music-profile-panel" aria-label="音乐画像">
      <header>
        <div><span>音乐画像</span><strong>{taste.summary}</strong></div>
        <button type="button" onClick={() => onSignalAction(undefined, "reset_automatic")}>重置自动信号</button>
      </header>

      <section className="manual-rule-card">
        <div><strong>taste.md 固定规则</strong><small>只读 · 修改需编辑文件 {taste.document.path}</small></div>
        {manualLabels.length > 0 ? <ul>{manualLabels.map((label) => <li key={label}>{label}</li>)}</ul> : <p>暂无人工加权或屏蔽。</p>}
      </section>

      {groups.map((group) => {
        const signals = taste.signals?.[group.key] ?? [];
        return (
          <section className="profile-signal-group" key={group.key}>
            <h3>{group.label}</h3>
            {signals.length > 0 ? (
              <ul>
                {signals.map((signal) => (
                  <li key={signal.id}>
                    <div>
                      <strong>{signal.label}</strong>
                      <small>{signalMeta(signal)}</small>
                    </div>
                    {signal.locked ? <span className="signal-locked">固定</span> : (
                      <div className="signal-actions">
                        <button type="button" onClick={() => onSignalAction(signal, "confirm")}>确认</button>
                        <button type="button" onClick={() => onSignalAction(signal, "decrease")}>降低</button>
                        <button type="button" onClick={() => onSignalAction(signal, "block")}>屏蔽</button>
                        <button type="button" onClick={() => onSignalAction(signal, "delete")}>删除</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="profile-empty">暂无这类信号。</p>}
          </section>
        );
      })}
    </div>
  );
});

export interface ProactiveReminder {
  id: string;
  message: string;
  createdAt: string;
  kind: "period" | "early_skips" | "queue_change" | "preference" | "session_intent";
}

export const ProactiveDjCard = memo(function ProactiveDjCard({
  policyStatus,
  reminder
}: {
  policyStatus: IntelligencePolicyStatus | undefined;
  reminder: ProactiveReminder | null;
}) {
  return (
    <aside className={reminder ? "proactive-dj-card has-reminder" : "proactive-dj-card"} aria-live="polite">
      <div><span className="proactive-dot" aria-hidden="true" /><strong>适度提醒</strong></div>
      <p>{reminder?.message ?? "没有需要打断你的新变化；我会在重要调整时告诉你。"}</p>
      {policyStatus ? <small>智能策略 {policyStatus.mode} · {policyStatus.version}{policyStatus.fallbackReason ? ` · ${policyStatus.fallbackReason}` : ""}</small> : null}
    </aside>
  );
});

function scopeLabel(scope: LearningReceipt["scope"]): string {
  return scope === "long_term" ? "长期有效" : scope === "day" ? "今天有效" : "当前会话有效";
}

function signalMeta(signal: TasteSignal): string {
  const source = signal.source === "explicit" ? "显式" : signal.source === "implicit" ? "隐式" : signal.source === "manual_rule" ? "人工" : "旧基线";
  const scope = scopeLabel(signal.scope);
  const direction = signal.weight < 0 ? "负向" : signal.weight > 0 ? "正向" : "中性";
  const magnitude = Math.abs(signal.weight);
  const strength = magnitude >= 0.75 ? "强" : magnitude >= 0.4 ? "中等" : "较弱";
  return `${source} · ${scope} · ${direction} · ${strength} · ${signal.evidenceCount} 条证据 · 更新于 ${new Date(signal.updatedAt).toLocaleDateString("zh-CN")}`;
}
