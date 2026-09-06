import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ExplicitFeedbackControls,
  LearningReceiptNotice,
  MusicClarificationCard,
  MusicTastePanel,
  ProactiveDjCard,
  WhyThisTrack
} from "./components/LearningControls";

describe("teachable DJ controls", () => {
  it("shows no more than three real recommendation evidence labels", () => {
    const html = renderToStaticMarkup(
      <WhyThisTrack
        decision={{
          decisionId: "decision-1",
          policyVersion: "policy-v1",
          evidence: [
            { type: "manual_rule", label: "taste.md：偏爱爵士", strength: 1, correctable: false },
            { type: "explicit_preference", label: "你常选这个艺人", strength: 0.8, correctable: true },
            { type: "session_intent", label: "现在想安静工作", strength: 0.7, correctable: true },
            { type: "legacy_baseline", label: "旧播放记录", strength: 0.2, correctable: false }
          ]
        }}
      />
    );

    expect(html).toContain("为什么放这首");
    expect(html).toContain("taste.md：偏爱爵士");
    expect(html).toContain("你常选这个艺人");
    expect(html).toContain("现在想安静工作");
    expect(html).not.toContain("旧播放记录");
    expect(html).not.toContain("0.8");
  });

  it("renders all five explicit correction choices", () => {
    const html = renderToStaticMarkup(
      <ExplicitFeedbackControls disabled={false} onFeedback={() => undefined} />
    );

    for (const label of ["不喜欢这首", "现在不合适", "听腻了", "少放这个艺人", "版本有问题"]) {
      expect(html).toContain(label);
    }
  });

  it("renders a learning receipt with queue impact and undo", () => {
    const html = renderToStaticMarkup(
      <LearningReceiptNotice
        busy={false}
        receipt={{
          receiptId: "receipt-1",
          scope: "long_term",
          changedSignals: [{
            signalId: "artist:eason",
            dimension: "artist",
            key: "陈奕迅",
            label: "少放陈奕迅",
            operation: "added",
            weight: -0.5,
            source: "explicit"
          }],
          replacedQueueCount: 3,
          summary: "以后会少放这个艺人。",
          undoToken: "undo-1",
          undoExpiresAt: new Date(Date.now() + 60_000).toISOString()
        }}
        onDismiss={() => undefined}
        onUndo={() => undefined}
      />
    );

    expect(html).toContain("以后会少放这个艺人");
    expect(html).toContain("后续队列替换 3 首");
    expect(html).toContain("撤销");
  });

  it("uses shadow-only receipt language without claiming the change is active", () => {
    const html = renderToStaticMarkup(
      <LearningReceiptNotice
        busy={false}
        receipt={{
          receiptId: "receipt-shadow",
          scope: "long_term",
          changedSignals: [],
          replacedQueueCount: 3,
          summary: "新偏好已生效，后续会少放。",
          undoToken: "undo-shadow",
          undoExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          appliedMode: "shadow_only"
        }}
        onDismiss={() => undefined}
        onUndo={() => undefined}
      />
    );

    expect(html).toContain("已记录，正在影子验证");
    expect(html).toContain("既有排序已实际替换 3 首");
    expect(html).not.toContain("已生效");
    expect(html).not.toContain("后续会少放");
  });

  it("shows a shadow-mode undo as an actual undo", () => {
    const html = renderToStaticMarkup(
      <LearningReceiptNotice
        busy={false}
        receipt={{
          receiptId: "receipt-shadow-undo",
          scope: "long_term",
          changedSignals: [{
            signalId: "signal-1",
            dimension: "artist",
            key: "artist",
            label: "恢复艺人偏好",
            operation: "removed",
            weight: 0,
            source: "explicit"
          }],
          replacedQueueCount: 0,
          summary: "已撤销：以后少放这个艺人。",
          undoToken: "undo-shadow-done",
          undoExpiresAt: new Date(0).toISOString(),
          appliedMode: "shadow_only"
        }}
        onDismiss={() => undefined}
        onUndo={() => undefined}
      />
    );

    expect(html).toContain("已撤销这次学习");
    expect(html).toContain("已撤销：以后少放这个艺人");
    expect(html).not.toContain("已记录，正在影子验证");
  });

  it("renders clarification candidates as explicit confirmation buttons", () => {
    const html = renderToStaticMarkup(
      <MusicClarificationCard
        busy={false}
        error={null}
        clarification={{
          question: "你指的是哪一首？",
          confirmationToken: "token",
          turnId: "turn",
          request: "播放同名歌曲",
          candidates: [
            { id: 1, title: "同名歌曲", artists: ["甲"] },
            { id: "002", trackKey: "qq:002", source: "qq", title: "同名歌曲（现场）", artists: ["乙"] }
          ]
        }}
        onCancel={() => undefined}
        onSelect={() => undefined}
      />
    );

    expect(html).toContain("你指的是哪一首？");
    expect(html).toContain("同名歌曲（现场）");
    expect(html).toContain("确认播放");
  });

  it("keeps the music profile separate and marks taste.md rules read-only", () => {
    const html = renderToStaticMarkup(
      <MusicTastePanel
        taste={{
          generatedAt: new Date().toISOString(),
          summary: "偏爱安静的夜晚",
          topArtists: [],
          topTracks: [],
          favoritePeriods: [],
          moodWeights: { calm: 1, focus: 0, warm: 0, night: 0, energy: 0, nostalgia: 0, unknown: 0 },
          preferenceTags: [],
          pacingPreference: "gentle",
          manualRules: {
            tagWeights: { jazz: 1 },
            artistWeights: {},
            blockedTags: ["ambient"],
            blockedArtists: []
          },
          document: {
            path: "state/taste.md",
            valid: true,
            manualRules: {
              tagWeights: { jazz: 1 },
              artistWeights: {},
              blockedTags: ["ambient"],
              blockedArtists: []
            }
          },
          signals: {
            explicit: [{
              id: "artist:eason",
              dimension: "artist",
              key: "陈奕迅",
              label: "少放陈奕迅",
              weight: -0.5,
              confidence: 1,
              source: "explicit",
              scope: "long_term",
              evidenceCount: 1,
              sessionCount: 1,
              updatedAt: new Date().toISOString()
            }],
            implicit: [],
            legacy: []
          }
        }}
        onSignalAction={() => undefined}
      />
    );

    expect(html).toContain("音乐画像");
    expect(html).not.toContain("她记得的我");
    expect(html).toContain("taste.md 固定规则");
    expect(html).toContain("需编辑文件");
    expect(html).toContain("确认");
    expect(html).toContain("降低");
    expect(html).toContain("屏蔽");
    expect(html).toContain("删除");
    expect(html).toContain("负向 · 中等");
  });

  it("keeps the proactive card visible even when there is no alert", () => {
    const html = renderToStaticMarkup(<ProactiveDjCard reminder={null} policyStatus={undefined} />);
    expect(html).toContain("适度提醒");
    expect(html).toContain("没有需要打断你的新变化");
  });
});
