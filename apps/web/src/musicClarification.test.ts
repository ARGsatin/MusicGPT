import { describe, expect, it } from "vitest";

import type { MusicCommandResult } from "@musicgpt/shared";
import {
  buildConfirmationRequest,
  pendingClarificationFromResult
} from "./musicClarification";

const now = { queue: [], paused: false };

describe("text music command clarification", () => {
  it("keeps the original turn and source-qualified candidate for the confirmation call", () => {
    const first: MusicCommandResult = {
      action: "play_specific",
      outcome: "needs_confirmation",
      summary: "请确认版本",
      now,
      confirmationToken: "confirm-1",
      clarification: {
        question: "你想听哪一个版本？",
        candidates: [{
          id: "003abc",
          trackKey: "qq:003abc",
          source: "qq",
          title: "候选歌曲",
          artists: ["歌手"]
        }]
      }
    };
    const pending = pendingClarificationFromResult(first, {
      turnId: "turn-1",
      request: "播放候选歌曲"
    });

    expect(pending?.question).toBe("你想听哪一个版本？");
    expect(buildConfirmationRequest(pending!, pending!.candidates[0]!)).toMatchObject({
      turnId: "turn-1",
      request: "播放候选歌曲",
      confirmationToken: "confirm-1",
      selectedTrackId: "qq:003abc",
      mode: "text_suggest"
    });
  });

  it("supports a second clarification round and clears only after execution", () => {
    const context = { turnId: "turn-2", request: "播放同名歌曲" };
    const first = pendingClarificationFromResult({
      action: "play_specific",
      outcome: "needs_confirmation",
      summary: "先选歌曲",
      now,
      confirmationToken: "token-a",
      clarification: {
        question: "先选歌曲",
        candidates: [{ id: 1, title: "同名歌曲", artists: ["甲"] }]
      }
    }, context)!;
    const second = pendingClarificationFromResult({
      action: "play_specific",
      outcome: "needs_confirmation",
      summary: "再选版本",
      now,
      confirmationToken: "token-b",
      clarification: {
        question: "再选具体版本",
        candidates: [{ id: 2, title: "现场版", artists: ["甲"] }]
      }
    }, first);

    expect(second).toMatchObject({ confirmationToken: "token-b", turnId: "turn-2", request: "播放同名歌曲" });
    expect(pendingClarificationFromResult({
      action: "play_specific",
      outcome: "executed",
      summary: "开始播放",
      now
    }, second!)).toBeNull();
  });
});
