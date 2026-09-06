import { describe, expect, it } from "vitest";

import { buildTeachingFeedback } from "./teachingFeedback";

describe("explicit correction feedback", () => {
  it("uses teach for every shortcut so corrections never cancel favorites", () => {
    const reasons = [
      "dislike_track",
      "wrong_for_now",
      "overplayed",
      "less_this_artist",
      "bad_version"
    ] as const;

    for (const reason of reasons) {
      expect(buildTeachingFeedback({ reason, trackId: "qq:003abc", listenedMs: 10_000 }).type).toBe("teach");
    }
  });

  it("keeps now/version corrections session-scoped and durable taste corrections long-term", () => {
    expect(buildTeachingFeedback({ reason: "wrong_for_now", trackId: 1, listenedMs: 0 }).scope).toBe("session");
    expect(buildTeachingFeedback({ reason: "bad_version", trackId: 1, listenedMs: 0 }).scope).toBe("session");
    expect(buildTeachingFeedback({ reason: "less_this_artist", trackId: 1, listenedMs: 0 }).scope).toBe("long_term");
  });
});
