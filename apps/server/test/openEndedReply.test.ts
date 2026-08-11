import { describe, expect, it } from "vitest";

import {
  assessOpenEndedReply,
  generateAcceptedOpenEndedReply,
  OpenEndedReplyRejectedError
} from "../src/openEndedReply.js";

describe("open-ended reply quality", () => {
  it("rejects every legacy canned song review", () => {
    const legacyReplies = [
      "《Flower Dance》好听诶！DJ OKAWARI把节奏和声音放得很舒服，情绪刚刚好，陪你听着一点也不累～",
      "《Flower Dance》和现在的气氛很搭呀。编曲不挤，旋律又有小钩子，是越听越顺耳的那种！",
      "《Flower Dance》我喜欢它的分寸感～DJ OKAWARI把情绪放得很自然，重点到了，又不会一下子扑得太满。"
    ];

    for (const reply of legacyReplies) {
      expect(assessOpenEndedReply(reply, { kind: "comment", recentReplies: [] }).accepted).toBe(false);
    }
  });

  it("rejects a song-review skeleton recently used for another track", () => {
    const previous = "《First Light》里钢琴的断句很短，鼓点进来以后速度感更清楚。";
    const repeated = "《Second Wind》里钢琴的断句很短，鼓点进来以后速度感更清楚。";

    const assessment = assessOpenEndedReply(repeated, {
      kind: "comment",
      recentReplies: [previous]
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.issues).toContain("recent_duplicate");
  });

  it("ignores both track and artist names when comparing repeated skeletons", () => {
    const previous = "《First Light》— Mira Vale：副歌人声改用短断句。";
    const repeated = "《Second Wind》— Jon Hopkins：副歌人声改用短断句。";

    const assessment = assessOpenEndedReply(repeated, {
      kind: "comment",
      recentReplies: [previous]
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.issues).toContain("recent_duplicate");
  });

  it("requires a concrete musical observation in song comments", () => {
    expect(
      assessOpenEndedReply("这首歌很有感觉，整体很高级，也很耐听。", {
        kind: "comment",
        recentReplies: []
      })
    ).toMatchObject({ accepted: false, issues: expect.arrayContaining(["abstract_comment"]) });

    expect(
      assessOpenEndedReply("钢琴一直用短促的重复音型向前推，主旋律因此没有拖慢。", {
        kind: "comment",
        recentReplies: []
      }).accepted
    ).toBe(true);
  });

  it("rewrites one rejected draft and returns only the accepted reply", async () => {
    const drafts = [
      "《Flower Dance》我喜欢它的分寸感，重点到了，又不会一下子扑得太满。",
      "钢琴的重复音型一直向前滚，主旋律落下长音时也没有停住拍子。"
    ];
    const feedback: Array<{ draft: string; issues: string[] } | undefined> = [];

    const reply = await generateAcceptedOpenEndedReply(
      async (rejection) => {
        feedback.push(rejection);
        return drafts.shift() ?? "";
      },
      { kind: "comment", recentReplies: [] }
    );

    expect(reply).toBe("钢琴的重复音型一直向前滚，主旋律落下长音时也没有停住拍子。");
    expect(feedback).toEqual([
      undefined,
      {
        draft: "《Flower Dance》我喜欢它的分寸感，重点到了，又不会一下子扑得太满。",
        issues: expect.arrayContaining(["canned_language"])
      }
    ]);
  });

  it("stops after two rejected drafts", async () => {
    let attempts = 0;

    await expect(
      generateAcceptedOpenEndedReply(
        async () => {
          attempts += 1;
          return "这首歌很有感觉，也很耐听。";
        },
        { kind: "comment", recentReplies: [] }
      )
    ).rejects.toBeInstanceOf(OpenEndedReplyRejectedError);
    expect(attempts).toBe(2);
  });
});
