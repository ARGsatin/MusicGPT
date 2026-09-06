import { describe, expect, it } from "vitest";

import type { TasteManualRules, TasteProfile, TrackStat } from "@musicgpt/shared";
import { ListeningPolicy } from "../src/listeningPolicy.js";

const profile: TasteProfile = {
  generatedAt: "2026-08-25T00:00:00.000Z",
  summary: "policy test",
  topArtists: [],
  topTracks: [],
  favoritePeriods: [],
  moodWeights: {
    calm: 0,
    focus: 0,
    warm: 0,
    night: 0,
    energy: 0,
    nostalgia: 0,
    unknown: 1
  },
  preferenceTags: [],
  pacingPreference: "balanced"
};

const rules: TasteManualRules = {
  artistWeights: {},
  tagWeights: {},
  blockedArtists: [],
  blockedTags: []
};

describe("ListeningPolicy", () => {
  it("requires evidence for hard inclusions and preserves hard exclusions", () => {
    const policy = new ListeningPolicy();
    const ranked = policy.rank({ profile, rules, stats: [
      { track: { id: 701, title: "Unknown", artists: ["Unknown"] }, playCount: 100 },
      { track: { id: 702, title: "Known", artists: ["Singer"], tags: [{ category: "style", value: "女声" }] }, playCount: 1 },
      { track: { id: 703, title: "Instrumental Version", artists: ["Singer"], tags: [{ category: "style", value: "女声" }] }, playCount: 90 }
    ], context: { constraints: [{ kind: "include", value: "女声", hard: true }, { kind: "avoid", value: "器乐", hard: true }] } });
    expect(ranked.map((decision) => decision.track.id)).toEqual([702]);
  });
  it("applies explicit feedback to every source version of one recording", () => {
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => "policy-id"
    });
    const sharedNcm: TrackStat = {
      track: {
        id: 1,
        trackKey: "ncm:1",
        recordingKey: "recording:shared",
        source: "ncm",
        sourceId: "1",
        title: "Shared",
        artists: ["Shared Artist"]
      },
      playCount: 100
    };
    const safe: TrackStat = {
      track: {
        id: 2,
        trackKey: "ncm:2",
        recordingKey: "recording:safe",
        source: "ncm",
        sourceId: "2",
        title: "Safe",
        artists: ["Safe Artist"]
      },
      playCount: 4
    };

    const receipt = policy.observe({
      observationId: "feedback-1",
      kind: "explicit_feedback",
      track: sharedNcm.track,
      reason: "dislike_track",
      scope: "long_term",
      at: "2026-08-25T07:59:00.000Z"
    });
    const ranked = policy.rank({
      stats: [sharedNcm, safe],
      candidates: [{
        track: {
          ...sharedNcm.track,
          id: "qq-shared",
          trackKey: "qq:qq-shared",
          source: "qq",
          sourceId: "qq-shared"
        },
        source: "ncm_daily",
        tags: [],
        relevanceScore: 1,
        discoveredAt: "2026-08-25T07:00:00.000Z",
        expiresAt: "2026-08-26T07:00:00.000Z"
      }],
      profile,
      rules,
      context: { sessionId: "session-1", period: "morning" }
    });

    expect(receipt.scope).toBe("long_term");
    expect(receipt.changedSignals).toEqual([
      expect.objectContaining({ targetType: "recording", targetKey: "recording:shared", source: "explicit" })
    ]);
    expect(receipt.operations).toEqual({ [receipt.changedSignals[0]!.signalId]: "added" });
    expect(ranked.filter((decision) => decision.recordingKey === "recording:shared")).toHaveLength(1);
    expect(ranked.findIndex((decision) => decision.recordingKey === "recording:shared")).toBeGreaterThan(
      ranked.findIndex((decision) => decision.recordingKey === "recording:safe")
    );
    expect(ranked.find((decision) => decision.recordingKey === "recording:shared")?.evidence[0]).toEqual(
      expect.objectContaining({ type: "explicit_preference", correctable: true })
    );
    expect(policy.profile().signals).toEqual([
      expect.objectContaining({ targetKey: "recording:shared", source: "explicit" })
    ]);
  });

  it("cools only a failed source version without changing recording taste", () => {
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => "failure-id"
    });
    const ncm: TrackStat = {
      track: {
        id: 10,
        trackKey: "ncm:10",
        recordingKey: "recording:ten",
        source: "ncm",
        sourceId: "10",
        title: "Same Recording",
        artists: ["Artist Ten"]
      },
      playCount: 20,
      localFavoritedAt: "2026-08-20T00:00:00.000Z"
    };
    const qq = {
      ...ncm.track,
      id: "qq-ten",
      trackKey: "qq:qq-ten",
      source: "qq" as const,
      sourceId: "qq-ten"
    };
    const candidates = [{
      track: qq,
      source: "ncm_daily" as const,
      tags: [],
      relevanceScore: 0,
      discoveredAt: "2026-08-25T07:00:00.000Z",
      expiresAt: "2026-08-26T07:00:00.000Z"
    }];

    expect(policy.rank({ stats: [ncm], candidates, profile, rules })[0]?.track.trackKey).toBe("ncm:10");
    policy.observe({
      observationId: "outcome-error",
      kind: "playback_outcome",
      track: ncm.track,
      outcome: "playback_error",
      at: "2026-08-25T07:59:00.000Z",
      sessionId: "session-1"
    });

    expect(policy.rank({ stats: [ncm], candidates, profile, rules, context: { sessionId: "session-1" } })[0]?.track.trackKey)
      .toBe("qq:qq-ten");
    expect(policy.profile().signals).toEqual([
      expect.objectContaining({
        targetType: "version",
        targetKey: "ncm:10",
        direction: "neutral",
        source: "implicit"
      })
    ]);
    expect(policy.profile().signals.some((signal) =>
      signal.targetType === "recording" || signal.targetType === "artist"
    )).toBe(false);
  });

  it("keeps one implicit outcome session-scoped and promotes three consistent outcomes across sessions", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `implicit-${++sequence}`
    });
    const track = {
      id: 20,
      trackKey: "ncm:20",
      recordingKey: "recording:twenty",
      source: "ncm" as const,
      sourceId: "20",
      title: "Patient Listen",
      artists: ["Patient Artist"],
      durationMs: 100_000
    };

    const first = policy.observe({
      observationId: "complete-1",
      kind: "playback_outcome",
      track,
      outcome: "completed",
      listenedMs: 90_000,
      durationMs: 100_000,
      at: "2026-08-25T07:00:00.000Z",
      sessionId: "session-a"
    });

    expect(first.changedSignals).toEqual([
      expect.objectContaining({ source: "implicit", direction: "positive", scope: "session" })
    ]);
    expect(policy.profile().signals.some((signal) => signal.scope === "long_term")).toBe(false);

    policy.observe({
      observationId: "complete-2",
      kind: "playback_outcome",
      track,
      outcome: "completed",
      listenedMs: 95_000,
      durationMs: 100_000,
      at: "2026-08-25T07:10:00.000Z",
      sessionId: "session-b"
    });
    const promoted = policy.observe({
      observationId: "complete-3",
      kind: "playback_outcome",
      track,
      outcome: "completed",
      listenedMs: 85_000,
      durationMs: 100_000,
      at: "2026-08-25T07:20:00.000Z",
      sessionId: "session-b"
    });

    expect(promoted.changedSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "implicit",
        targetType: "recording",
        targetKey: "recording:twenty",
        direction: "positive",
        scope: "long_term",
        observationIds: ["complete-1", "complete-2", "complete-3"]
      })
    ]));
  });

  it("derives skip learning from observations instead of unreversible raw play events", () => {
    const policy = new ListeningPolicy({ now: () => new Date("2026-08-25T08:00:00.000Z") });
    const stats: TrackStat[] = [{
      track: {
        id: 21,
        trackKey: "ncm:21",
        recordingKey: "recording:twenty-one",
        source: "ncm",
        sourceId: "21",
        title: "Raw Event",
        artists: ["Audit Artist"]
      },
      playCount: 12,
      localFavoritedAt: "2026-08-20T00:00:00.000Z"
    }];
    const baseline = policy.rank({ stats, profile, rules });
    const withRawSkips = policy.rank({
      stats,
      profile,
      rules,
      events: [
        { type: "skip", trackId: "ncm:21", at: "2026-08-25T07:59:00.000Z" },
        { type: "skip", trackId: "ncm:21", at: "2026-08-25T07:58:00.000Z" }
      ]
    });

    expect(withRawSkips).toHaveLength(1);
    expect(withRawSkips[0]?.score).toBe(baseline[0]?.score);
    expect(withRawSkips[0]?.evidence.some((item) => item.label.includes("跳过"))).toBe(false);
  });

  it("undoes only one implicit fact and recomputes a surviving long-term aggregate", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `aggregate-${++sequence}`
    });
    const track = {
      id: 22,
      trackKey: "ncm:22",
      recordingKey: "recording:twenty-two",
      source: "ncm" as const,
      sourceId: "22",
      title: "Aggregate",
      artists: ["Aggregate Artist"],
      durationMs: 100_000
    };
    const observe = (index: number, sessionId: string) => policy.observe({
      observationId: `complete-${index}`,
      kind: "playback_outcome" as const,
      track,
      outcome: "completed" as const,
      listenedMs: 90_000,
      durationMs: 100_000,
      at: `2026-08-25T07:${String(index).padStart(2, "0")}:00.000Z`,
      sessionId
    });
    observe(1, "session-a");
    observe(2, "session-b");
    observe(3, "session-b");
    const fourth = observe(4, "session-a");

    expect(policy.undo(fourth.undoToken)).toBeDefined();
    const aggregateAfterUndo = policy.profile().signals.find((signal) =>
      signal.source === "implicit" && signal.scope === "long_term" && signal.targetKey === track.recordingKey
    );
    expect(aggregateAfterUndo).toMatchObject({
      observationIds: ["complete-1", "complete-2", "complete-3"]
    });
    expect(aggregateAfterUndo?.reversedAt).toBeUndefined();
    expect(policy.profile().signals.find((signal) =>
      signal.scope === "session" && signal.observationIds.includes("complete-4")
    )?.reversedAt).toBeDefined();

    observe(5, "session-a");
    expect(policy.profile().signals.find((signal) =>
      signal.source === "implicit" && signal.scope === "long_term" && signal.targetKey === track.recordingKey
    )?.observationIds).toEqual(["complete-1", "complete-2", "complete-3", "complete-5"]);
  });

  it("undoes an explicit lesson within ten minutes while retaining an audit marker", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `undo-${++sequence}`
    });
    const track = {
      id: 30,
      trackKey: "ncm:30",
      recordingKey: "recording:thirty",
      source: "ncm" as const,
      sourceId: "30",
      title: "Undo Song",
      artists: ["Undo Artist"]
    };
    const receipt = policy.observe({
      observationId: "feedback-undo",
      kind: "explicit_feedback",
      track,
      reason: "dislike_track",
      scope: "long_term",
      at: "2026-08-25T07:59:00.000Z"
    });

    const undone = policy.undo(receipt.undoToken);

    expect(undone).toEqual(expect.objectContaining({ undoneAt: "2026-08-25T08:00:00.000Z" }));
    expect(policy.profile().signals).toEqual([
      expect.objectContaining({
        targetKey: "recording:thirty",
        reversedAt: "2026-08-25T08:00:00.000Z",
        reversedByObservationId: expect.any(String)
      })
    ]);
    expect(policy.rank({
      stats: [{ track, playCount: 10 }],
      profile,
      rules
    })[0]?.evidence.some((evidence) => evidence.type === "explicit_preference")).toBe(false);
  });

  it("adjusts a period quota by at most one after twenty valid observations and keeps guardrails", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `quota-${++sequence}`
    });
    const track = {
      id: 40,
      trackKey: "ncm:40",
      recordingKey: "recording:forty",
      source: "ncm" as const,
      sourceId: "40",
      title: "Morning Explore",
      artists: ["Quota Artist"],
      durationMs: 100_000
    };
    for (let index = 0; index < 20; index += 1) {
      policy.observe({
        observationId: `quota-complete-${index}`,
        kind: "playback_outcome",
        track: { ...track, id: 40 + index, trackKey: `ncm:${40 + index}`, recordingKey: `recording:${40 + index}` },
        outcome: "completed",
        listenedMs: 90_000,
        durationMs: 100_000,
        at: `2026-08-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        sessionId: `session-${index % 2}`,
        dayPeriod: "morning"
      });
    }

    expect(policy.profile().quotas).toEqual({
      morningExplore: 5,
      afternoonSoft: 7,
      afternoonClassical: 2,
      eveningMemory: 8
    });

    for (let index = 20; index < 40; index += 1) {
      policy.observe({
        observationId: `quota-complete-${index}`,
        kind: "playback_outcome",
        track: { ...track, id: 40 + index, trackKey: `ncm:${40 + index}`, recordingKey: `recording:${40 + index}` },
        outcome: "completed",
        listenedMs: 90_000,
        durationMs: 100_000,
        at: `2026-08-25T07:${String(index).padStart(2, "0")}:00.000Z`,
        sessionId: `session-${index % 2}`,
        dayPeriod: "morning"
      });
    }

    expect(policy.profile().quotas.morningExplore).toBe(5);
  });

  it("lets users lower or delete an automatic signal and undo the correction", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `correction-${++sequence}`
    });
    const track = {
      id: 80,
      trackKey: "ncm:80",
      recordingKey: "recording:eighty",
      source: "ncm" as const,
      sourceId: "80",
      title: "Correct Me",
      artists: ["Correctable Artist"],
      durationMs: 100_000
    };
    policy.observe({
      observationId: "implicit-source",
      kind: "playback_outcome",
      track,
      outcome: "completed",
      listenedMs: 90_000,
      durationMs: 100_000,
      at: "2026-08-25T07:55:00.000Z",
      sessionId: "session-correction"
    });
    const signal = policy.profile().signals[0]!;

    const lowered = policy.observe({
      observationId: "lower-signal",
      kind: "signal_correction",
      track,
      targetSignalId: signal.signalId,
      correction: "decrease",
      scope: "long_term",
      at: "2026-08-25T07:59:00.000Z"
    });

    expect(policy.profile().signals[0]?.strength).toBeLessThan(signal.strength);
    expect(lowered.summary).toContain("降低");
    expect(lowered.operations?.[signal.signalId]).toBe("updated");
    expect(policy.undo(lowered.undoToken)?.operations?.[signal.signalId]).toBe("updated");
    expect(policy.profile().signals[0]?.strength).toBe(signal.strength);

    const deleted = policy.observe({
      observationId: "delete-signal",
      kind: "signal_correction",
      track,
      targetSignalId: signal.signalId,
      correction: "delete",
      scope: "long_term",
      at: "2026-08-25T08:00:00.000Z"
    });
    expect(deleted.operations?.[signal.signalId]).toBe("removed");
    expect(policy.profile().signals[0]?.reversedAt).toBeDefined();
    expect(policy.undo(deleted.undoToken)?.operations?.[signal.signalId]).toBe("added");
  });

  it("coalesces a newer aggregate when undoing a correction instead of duplicating long-term taste", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:30:00.000Z"),
      id: () => `interleaved-${++sequence}`
    });
    const track = {
      id: 81,
      trackKey: "ncm:81",
      recordingKey: "recording:eighty-one",
      source: "ncm" as const,
      sourceId: "81",
      title: "Interleaved",
      artists: ["Interleaved Artist"],
      durationMs: 100_000
    };
    const complete = (index: number, sessionId: string) => policy.observe({
      observationId: `interleaved-complete-${index}`,
      kind: "playback_outcome" as const,
      track,
      outcome: "completed" as const,
      listenedMs: 90_000,
      durationMs: 100_000,
      at: `2026-08-25T08:${String(index).padStart(2, "0")}:00.000Z`,
      sessionId
    });
    complete(1, "session-a");
    complete(2, "session-b");
    complete(3, "session-b");
    const aggregate = policy.profile().signals.find((signal) =>
      signal.source === "implicit" && signal.scope === "long_term"
    )!;
    const confirmation = policy.observe({
      observationId: "confirm-interleaved-aggregate",
      kind: "signal_correction",
      track,
      targetSignalId: aggregate.signalId,
      correction: "confirm",
      scope: "long_term",
      at: "2026-08-25T08:10:00.000Z"
    });
    complete(4, "session-a");

    expect(policy.profile().signals.filter((signal) =>
      signal.source === "implicit" &&
      signal.scope === "long_term" &&
      signal.targetKey === track.recordingKey &&
      !signal.reversedAt
    )).toHaveLength(1);

    policy.undo(confirmation.undoToken);

    const activeAggregates = policy.profile().signals.filter((signal) =>
      signal.source === "implicit" &&
      signal.scope === "long_term" &&
      signal.targetKey === track.recordingKey &&
      !signal.reversedAt
    );
    expect(activeAggregates).toHaveLength(1);
    expect(activeAggregates[0]?.observationIds).toEqual([
      "interleaved-complete-1",
      "interleaved-complete-2",
      "interleaved-complete-3",
      "interleaved-complete-4"
    ]);
  });

  it("resets automatic signals but never mutates taste.md manual rules", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: () => `reset-${++sequence}`,
      state: {
        signals: [{
          signalId: "manual-signal",
          source: "manual",
          targetType: "artist",
          targetKey: "protected",
          direction: "positive",
          strength: 1,
          scope: "long_term",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
          observationIds: [],
          label: "taste.md fixed"
        }, {
          signalId: "automatic-signal",
          source: "implicit",
          targetType: "recording",
          targetKey: "recording:auto",
          direction: "positive",
          strength: 0.2,
          scope: "long_term",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
          observationIds: ["old-outcome"],
          label: "automatic"
        }]
      }
    });

    policy.observe({
      observationId: "reset-automatic",
      kind: "signal_correction",
      track: { id: "policy:reset", title: "Music profile", artists: [] },
      correction: "reset_automatic",
      scope: "long_term",
      at: "2026-08-25T08:00:00.000Z"
    });

    expect(policy.profile().signals.find((entry) => entry.signalId === "manual-signal")?.reversedAt).toBeUndefined();
    expect(policy.profile().signals.find((entry) => entry.signalId === "automatic-signal")?.reversedAt).toBeDefined();
  });

  it("turns a structured long-term preference into an explicit artist signal", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({ id: () => `preference-${++sequence}` });
    const receipt = policy.observe({
      observationId: "prefer-artist",
      kind: "explicit_feedback",
      track: { id: "policy:artist", title: "Artist preference", artists: ["陈奕迅"] },
      at: "2026-08-25T08:00:00.000Z",
      scope: "long_term",
      structuredPreferences: [{
        targetType: "artist",
        targetKey: "陈奕迅",
        direction: "positive",
        strength: 0.75,
        label: "你希望以后多放陈奕迅"
      }]
    });

    expect(receipt.changedSignals).toEqual([
      expect.objectContaining({
        source: "explicit",
        targetType: "artist",
        targetKey: "陈奕迅",
        direction: "positive",
        scope: "long_term"
      })
    ]);
  });

  it("uses a structured tag preference in later ranking decisions", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({ id: () => `tag-preference-${++sequence}` });
    const jazz = {
      id: 91,
      title: "Jazz Choice",
      artists: ["Artist A"],
      tags: [{ category: "style" as const, value: "jazz" }]
    };
    const rock = {
      id: 92,
      title: "Rock Choice",
      artists: ["Artist B"],
      tags: [{ category: "style" as const, value: "rock" }]
    };
    policy.observe({
      observationId: "prefer-jazz",
      kind: "explicit_feedback",
      track: { id: "policy:jazz", title: "Jazz preference", artists: [] },
      at: "2026-08-25T08:00:00.000Z",
      scope: "long_term",
      structuredPreferences: [{
        targetType: "tag",
        targetKey: "jazz",
        direction: "positive",
        strength: 0.75,
        label: "你希望以后多放 jazz"
      }]
    });

    const ranked = policy.rank({
      stats: [{ track: jazz, playCount: 1 }, { track: rock, playCount: 1 }],
      profile,
      rules,
      random: () => 0
    });

    expect(ranked[0]?.track.id).toBe(91);
    expect(ranked[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "explicit_preference", label: "你希望以后多放 jazz" })
    ]));
  });

  it("deletes a legacy baseline without turning that recording into a hard dislike", () => {
    const policy = new ListeningPolicy();
    const track = {
      id: 95,
      trackKey: "ncm:95",
      recordingKey: "recording:ninety-five",
      source: "ncm" as const,
      sourceId: "95",
      title: "Delete Baseline",
      artists: ["Baseline Artist"]
    };
    policy.observe({
      observationId: "delete-legacy-baseline",
      kind: "explicit_feedback",
      track,
      at: "2026-08-25T08:00:00.000Z",
      scope: "long_term",
      structuredPreferences: [{
        targetType: "recording",
        targetKey: track.recordingKey,
        direction: "neutral",
        strength: 0,
        label: "你已删除旧基线：既有播放记录"
      }]
    });

    const decisions = policy.rank({
      stats: [
        { track, playCount: 100, localFavoritedAt: "2026-08-20T00:00:00.000Z" },
        { track: { id: 96, title: "Safe", artists: ["Safe Artist"] }, playCount: 1 }
      ],
      profile,
      rules,
      random: () => 0
    });
    const decision = decisions.find((entry) => entry.recordingKey === track.recordingKey);
    expect(decision).toBeDefined();
    expect(decision?.evidence.some((entry) => entry.type === "legacy_baseline")).toBe(false);
    expect(decision?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "explicit_preference", label: expect.stringContaining("删除旧基线") })
    ]));
  });

  it("never lets an automatic or explicit multiplier reverse a taste.md manual downweight", () => {
    let sequence = 0;
    const policy = new ListeningPolicy({ id: () => `manual-priority-${++sequence}` });
    const downweighted = { id: 101, title: "Manual Down", artists: ["Manual Artist"] };
    const neutral = { id: 102, title: "Neutral", artists: ["Neutral Artist"] };
    policy.observe({
      observationId: "explicit-manual-artist",
      kind: "explicit_feedback",
      track: downweighted,
      at: "2026-08-25T08:00:00.000Z",
      scope: "long_term",
      structuredPreferences: [{
        targetType: "artist",
        targetKey: "manual artist",
        direction: "positive",
        strength: 1,
        label: "explicit boost"
      }]
    });

    const ranked = policy.rank({
      stats: [{ track: downweighted, playCount: 1 }, { track: neutral, playCount: 1 }],
      profile,
      rules: { ...rules, artistWeights: { "Manual Artist": 0.8 } },
      random: () => 0
    });

    expect(ranked[0]?.track.id).toBe(102);
  });

  it("rolls back an in-memory observation when its atomic persistence commit fails", () => {
    let sequence = 0;
    let failCommit = true;
    const policy = new ListeningPolicy({
      id: () => `atomic-${++sequence}`,
      persistence: {
        commitLearningMutation: () => {
          if (failCommit) throw new Error("commit-failed");
        }
      }
    });
    const observation = {
      observationId: "retry-observation",
      kind: "explicit_feedback" as const,
      track: { id: 501, title: "Retry", artists: ["Retry Artist"] },
      reason: "dislike_track" as const,
      scope: "long_term" as const,
      at: "2026-08-25T08:00:00.000Z"
    };

    expect(() => policy.observe(observation)).toThrow("commit-failed");
    expect(policy.profile().signals).toEqual([]);

    failCommit = false;
    const receipt = policy.observe(observation);
    expect(receipt.changedSignals).toHaveLength(1);
    expect(policy.profile().signals).toEqual([
      expect.objectContaining({ targetType: "recording", direction: "negative" })
    ]);
  });
});
