import { describe, expect, it } from "vitest";

import type {
  PlayEvent,
  RecommendationCandidate,
  TasteManualRules,
  TasteProfile,
  TrackStat
} from "@musicgpt/shared";
import { RadioPlanner } from "../src/radioPlanner.js";
import { ListeningPolicy } from "../src/listeningPolicy.js";

const stats: TrackStat[] = [
  {
    track: { id: 1, title: "Morning Song", artists: ["A"], moodTag: "calm" },
    playCount: 80,
    lastPlayedHour: 8
  },
  {
    track: { id: 2, title: "Night Song", artists: ["B"], moodTag: "night" },
    playCount: 70,
    lastPlayedHour: 23
  },
  {
    track: { id: 3, title: "Focus Song", artists: ["C"], moodTag: "focus" },
    playCount: 50,
    lastPlayedHour: 10
  }
];

const profile: TasteProfile = {
  generatedAt: new Date().toISOString(),
  summary: "test",
  topArtists: [],
  topTracks: [],
  favoritePeriods: [
    { period: "morning", weight: 0.7 },
    { period: "late_night", weight: 0.1 },
    { period: "afternoon", weight: 0.1 },
    { period: "evening", weight: 0.1 }
  ],
  moodWeights: {
    calm: 0.3,
    focus: 0.3,
    warm: 0.1,
    night: 0.1,
    energy: 0.1,
    nostalgia: 0.05,
    unknown: 0.05
  },
  preferenceTags: [],
  pacingPreference: "balanced"
};

const manualRules: TasteManualRules = {
  artistWeights: {},
  tagWeights: {},
  blockedArtists: [],
  blockedTags: []
};

describe("RadioPlanner", () => {
  it("returns explainable ListeningPolicy decisions through the public plan", () => {
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z")
    });
    const planner = new RadioPlanner(() => 0.5, policy);

    const plan = planner.plan(stats, profile, []);
    const first = plan[0];

    expect(first).toEqual(expect.objectContaining({
      decisionId: expect.any(String),
      policyVersion: expect.any(String),
      evidence: expect.any(Array)
    }));
    expect(policy.explain(first!.decisionId!)).toEqual(expect.objectContaining({
      decisionId: first!.decisionId,
      track: expect.objectContaining({ id: first!.track.id })
    }));
  });

  it("keeps legacy ordering in shadow mode while adaptive mode applies policy rules", () => {
    const policy = new ListeningPolicy({ id: () => "shadow-policy" });
    const shadowStats: TrackStat[] = [
      { track: { id: 501, title: "Legacy Favorite", artists: ["Legacy Artist"] }, playCount: 100 },
      { track: { id: 502, title: "Allowed Track", artists: ["Allowed Artist"] }, playCount: 1 }
    ];
    policy.observe({
      observationId: "shadow-dislike",
      kind: "explicit_feedback",
      track: shadowStats[0]!.track,
      reason: "dislike_track",
      scope: "long_term",
      at: "2026-08-25T08:00:00.000Z"
    });
    const planner = new RadioPlanner(() => 0.5, policy);

    const legacy = planner.plan(shadowStats, profile, [], { policyMode: "legacy", rules: manualRules });
    const shadow = planner.plan(shadowStats, profile, [], { policyMode: "shadow", rules: manualRules });
    const adaptive = planner.plan(shadowStats, profile, [], { policyMode: "adaptive", rules: manualRules });

    expect(legacy[0]?.track.id).toBe(501);
    expect(shadow[0]?.track.id).toBe(legacy[0]?.track.id);
    expect(shadow[0]?.decisionId).toBeUndefined();
    expect(shadow[0]?.evidence).toBeUndefined();
    expect(shadow[0]?.policyVersion).toBeUndefined();
    expect(adaptive[0]?.track.id).toBe(502);
  });

  it("reports the policy ranking computed in shadow mode without changing playback order", () => {
    const policy = new ListeningPolicy({ id: () => "audit-policy" });
    const shadowRankings: Array<Array<{ track: { id: number | string } }>> = [];
    const shadowStats: TrackStat[] = [
      { track: { id: 601, title: "Legacy Favorite", artists: ["Blocked Artist"] }, playCount: 100 },
      { track: { id: 602, title: "Allowed Track", artists: ["Allowed Artist"] }, playCount: 1 }
    ];

    policy.observe({
      observationId: "audit-dislike",
      kind: "explicit_feedback",
      track: shadowStats[0]!.track,
      reason: "dislike_track",
      scope: "long_term",
      at: "2026-08-25T08:00:00.000Z"
    });
    const planner = new RadioPlanner(() => 0.5, policy);
    const shadow = planner.plan(shadowStats, profile, [], {
      policyMode: "shadow",
      rules: manualRules,
      onShadowRanking: (decisions) => shadowRankings.push(decisions)
    });

    expect(shadow[0]?.track.id).toBe(601);
    expect(shadowRankings).toHaveLength(1);
    expect(shadowRankings[0]?.[0]?.track.id).toBe(602);
  });

  it("honors taste.md hard blocks in legacy, shadow, and adaptive modes", () => {
    const planner = new RadioPlanner(() => 0.5);
    const statsWithBlock: TrackStat[] = [
      { track: { id: 701, title: "Blocked", artists: ["Blocked Artist"] }, playCount: 100 },
      { track: { id: 702, title: "Allowed", artists: ["Allowed Artist"] }, playCount: 1 }
    ];
    const blockedRules = { ...manualRules, blockedArtists: ["Blocked Artist"] };

    for (const policyMode of ["legacy", "shadow", "adaptive"] as const) {
      expect(planner.plan(statsWithBlock, profile, [], { policyMode, rules: blockedRules })[0]?.track.id).toBe(702);
    }
  });

  it("blocks every source variant when any recording variant matches a manual tag block", () => {
    const planner = new RadioPlanner(() => 0.5);
    const crossSourceStats: TrackStat[] = [
      {
        track: {
          id: "ncm-tag-base",
          trackKey: "ncm:ncm-tag-base",
          recordingKey: "rec:blocked-by-candidate-tag",
          source: "ncm",
          title: "Blocked By Candidate Tag",
          artists: ["Shared Artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "ncm-evidence-base",
          trackKey: "ncm:ncm-evidence-base",
          recordingKey: "rec:blocked-by-evidence",
          source: "ncm",
          title: "Blocked By Evidence",
          artists: ["Evidence Artist"]
        },
        playCount: 90
      },
      {
        track: {
          id: "qq-evidence-variant",
          trackKey: "qq:qq-evidence-variant",
          recordingKey: "rec:blocked-by-evidence",
          source: "qq",
          title: "Blocked By Evidence",
          artists: ["Evidence Artist"],
          tagEvidence: [{
            category: "style",
            value: "Blocked Style",
            confidence: 0.9,
            source: "platform"
          }]
        },
        playCount: 80
      },
      {
        track: {
          id: "ncm-allowed",
          trackKey: "ncm:ncm-allowed",
          recordingKey: "rec:allowed",
          source: "ncm",
          title: "Allowed",
          artists: ["Allowed Artist"]
        },
        playCount: 1
      }
    ];
    const candidates: RecommendationCandidate[] = [{
      track: {
        id: "qq-tag-variant",
        trackKey: "qq:qq-tag-variant",
        recordingKey: "rec:blocked-by-candidate-tag",
        source: "qq",
        title: "Blocked By Candidate Tag",
        artists: ["Shared Artist"]
      },
      source: "ncm_daily",
      tags: [{ category: "style", value: "Blocked Style" }],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }];
    const blockedRules = { ...manualRules, blockedTags: ["style:Blocked Style"] };

    for (const policyMode of ["legacy", "shadow", "adaptive"] as const) {
      const plan = planner.plan(crossSourceStats, profile, [], {
        policyMode,
        rules: blockedRules,
        candidates,
        windowSize: 10
      });

      expect(plan.map((item) => item.track.recordingKey), policyMode).toEqual(["rec:allowed"]);
    }
  });

  it("deduplicates cross-source variants by recording in legacy and shadow queues", () => {
    const planner = new RadioPlanner(() => 0.5);
    const crossSourceStats: TrackStat[] = [
      {
        track: {
          id: "ncm-shared",
          trackKey: "ncm:ncm-shared",
          recordingKey: "rec:shared",
          source: "ncm",
          title: "Shared Recording",
          artists: ["Shared Artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-shared",
          trackKey: "qq:qq-shared",
          recordingKey: "rec:shared",
          source: "qq",
          title: "Shared Recording",
          artists: ["Shared Artist"]
        },
        playCount: 90
      },
      {
        track: {
          id: "ncm-other",
          trackKey: "ncm:ncm-other",
          recordingKey: "rec:other",
          source: "ncm",
          title: "Other Recording",
          artists: ["Other Artist"]
        },
        playCount: 80
      }
    ];

    for (const policyMode of ["legacy", "shadow"] as const) {
      const plan = planner.plan(crossSourceStats, profile, [], {
        policyMode,
        rules: manualRules,
        windowSize: 3
      });

      expect(plan.map((item) => item.track.recordingKey), policyMode).toEqual([
        "rec:shared",
        "rec:other"
      ]);
    }
  });

  it("does not let duplicate familiar variants consume legacy exploration capacity", () => {
    const planner = new RadioPlanner(() => 0.5);
    const crossSourceStats: TrackStat[] = [
      {
        track: {
          id: "ncm-capacity-shared",
          trackKey: "ncm:ncm-capacity-shared",
          recordingKey: "rec:capacity-shared",
          source: "ncm",
          title: "Capacity Shared",
          artists: ["Shared Artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-capacity-shared",
          trackKey: "qq:qq-capacity-shared",
          recordingKey: "rec:capacity-shared",
          source: "qq",
          title: "Capacity Shared",
          artists: ["Shared Artist"]
        },
        playCount: 90
      },
      {
        track: {
          id: "ncm-capacity-two",
          trackKey: "ncm:ncm-capacity-two",
          recordingKey: "rec:capacity-two",
          source: "ncm",
          title: "Capacity Two",
          artists: ["Artist Two"]
        },
        playCount: 80
      },
      {
        track: {
          id: "ncm-capacity-three",
          trackKey: "ncm:ncm-capacity-three",
          recordingKey: "rec:capacity-three",
          source: "ncm",
          title: "Capacity Three",
          artists: ["Artist Three"]
        },
        playCount: 70
      }
    ];
    const candidates: RecommendationCandidate[] = [{
      track: {
        id: "ncm-capacity-explore",
        trackKey: "ncm:ncm-capacity-explore",
        recordingKey: "rec:capacity-explore",
        source: "ncm",
        title: "Capacity Explore",
        artists: ["Explore Artist"]
      },
      source: "ncm_daily",
      tags: [],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }];

    for (const policyMode of ["legacy", "shadow"] as const) {
      const plan = planner.plan(crossSourceStats, profile, [], {
        policyMode,
        rules: manualRules,
        candidates,
        windowSize: 5
      });
      const recordingKeys = plan.map((item) => item.track.recordingKey);

      expect(recordingKeys, policyMode).toHaveLength(4);
      expect(new Set(recordingKeys).size, policyMode).toBe(4);
      expect(recordingKeys, policyMode).toContain("rec:capacity-explore");
    }
  });

  it("shares raw skip cooldown across source variants in legacy and shadow queues", () => {
    const planner = new RadioPlanner(() => 0.5);
    const crossSourceStats: TrackStat[] = [
      {
        track: {
          id: "ncm-skipped",
          trackKey: "ncm:ncm-skipped",
          recordingKey: "rec:skipped",
          source: "ncm",
          title: "Skipped Recording",
          artists: ["Shared Artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-skipped",
          trackKey: "qq:qq-skipped",
          recordingKey: "rec:skipped",
          source: "qq",
          title: "Skipped Recording",
          artists: ["Shared Artist"]
        },
        playCount: 90
      },
      {
        track: {
          id: "ncm-steady",
          trackKey: "ncm:ncm-steady",
          recordingKey: "rec:steady",
          source: "ncm",
          title: "Steady Recording",
          artists: ["Steady Artist"]
        },
        playCount: 1
      }
    ];
    const now = Date.now();
    const skips: PlayEvent[] = [
      { type: "skip", trackId: "ncm:ncm-skipped", at: new Date(now - 1_000).toISOString() },
      { type: "skip", trackId: "ncm:ncm-skipped", at: new Date(now - 2_000).toISOString() }
    ];

    for (const policyMode of ["legacy", "shadow"] as const) {
      const plan = planner.plan(crossSourceStats, profile, skips, {
        policyMode,
        rules: manualRules,
        windowSize: 3
      });

      expect(plan.map((item) => item.track.recordingKey), policyMode).toEqual(["rec:steady"]);
    }
  });

  it("keeps raw playback-error cooldown scoped to the failed source version", () => {
    const planner = new RadioPlanner(() => 0.5);
    const crossSourceStats: TrackStat[] = [
      {
        track: {
          id: "ncm-failed",
          trackKey: "ncm:ncm-failed",
          recordingKey: "rec:version-failure",
          source: "ncm",
          title: "Version Failure",
          artists: ["Shared Artist"]
        },
        playCount: 100
      },
      {
        track: {
          id: "qq-playable",
          trackKey: "qq:qq-playable",
          recordingKey: "rec:version-failure",
          source: "qq",
          title: "Version Failure",
          artists: ["Shared Artist"]
        },
        playCount: 90
      },
      {
        track: {
          id: "ncm-steady-version-test",
          trackKey: "ncm:ncm-steady-version-test",
          recordingKey: "rec:steady-version-test",
          source: "ncm",
          title: "Steady Version Test",
          artists: ["Steady Artist"]
        },
        playCount: 1
      }
    ];
    const failure: PlayEvent[] = [{
      type: "playback_error",
      trackId: "ncm:ncm-failed",
      recordingKey: "rec:version-failure",
      at: new Date().toISOString()
    }];

    for (const policyMode of ["legacy", "shadow"] as const) {
      const plan = planner.plan(crossSourceStats, profile, failure, {
        policyMode,
        rules: manualRules,
        windowSize: 1
      });

      expect(plan[0]?.track.trackKey, policyMode).toBe("qq:qq-playable");
    }
  });

  it("falls back to legacy ordering when adaptive ranking fails", () => {
    class FailingPolicy extends ListeningPolicy {
      override rank(): never {
        throw new Error("ranking failed");
      }
    }
    const planner = new RadioPlanner(() => 0.5, new FailingPolicy());

    const plan = planner.plan(stats, profile, [], { policyMode: "adaptive" });

    expect(plan).toHaveLength(3);
    expect(plan[0]?.track.id).toBe(1);
    expect(plan[0]?.policyVersion).toBeUndefined();
  });

  it("returns ranked tracks with reasons", () => {
    const planner = new RadioPlanner(() => 0.5);
    const plan = planner.plan(stats, profile, []);

    expect(plan).toHaveLength(3);
    expect(plan[0]?.track.id).toBe(1);
    expect(plan[0]?.reason).toContain("偏好");
  });

  it("penalizes a reversible early-skip observation", () => {
    const now = new Date();
    const policy = new ListeningPolicy({ now: () => now });
    policy.observe({
      observationId: "radio-early-skip",
      kind: "playback_outcome",
      track: { ...stats[0]!.track, durationMs: 200_000 },
      outcome: "skipped",
      listenedMs: 10_000,
      durationMs: 200_000,
      activeSkip: true,
      sessionId: "radio-session",
      at: now.toISOString()
    });
    const planner = new RadioPlanner(() => 0.5, policy);
    const plan = planner.plan(stats, profile, [], { policyMode: "adaptive", sessionId: "radio-session" });
    const firstId = plan[0]?.track.id;

    expect(firstId).not.toBe(1);
  });

  it("uses graded observations, excludes an explicit cooldown, and keeps positive listening evidence", () => {
    const now = Date.now();
    const feedbackStats: TrackStat[] = [
      { track: { id: 11, title: "One Skip", artists: ["A"] }, playCount: 100 },
      {
        track: { id: 12, title: "Two Skips", artists: ["B"] },
        playCount: 90,
        localFavoritedAt: new Date(now - 5_000).toISOString()
      },
      { track: { id: 13, title: "Restored", artists: ["C"] }, playCount: 80 },
      { track: { id: 14, title: "Steady", artists: ["D"] }, playCount: 10 }
    ];
    const policy = new ListeningPolicy({ now: () => new Date(now) });
    policy.observe({
      observationId: "one-skip",
      kind: "playback_outcome",
      track: { ...feedbackStats[0]!.track, durationMs: 200_000 },
      outcome: "skipped",
      listenedMs: 10_000,
      durationMs: 200_000,
      sessionId: "graded-session",
      at: new Date(now - 2_000).toISOString()
    });
    policy.observe({
      observationId: "explicit-cooldown",
      kind: "explicit_feedback",
      track: feedbackStats[1]!.track,
      reason: "overplayed",
      scope: "long_term",
      at: new Date(now - 1_500).toISOString()
    });
    policy.observe({
      observationId: "positive-completion",
      kind: "playback_outcome",
      track: { ...feedbackStats[2]!.track, durationMs: 200_000 },
      outcome: "completed",
      listenedMs: 190_000,
      durationMs: 200_000,
      sessionId: "graded-session",
      at: new Date(now - 1_000).toISOString()
    });
    const planner = new RadioPlanner(() => 0.5, policy);
    const plan = planner.plan(feedbackStats, profile, [], {
      windowSize: 4,
      policyMode: "adaptive",
      sessionId: "graded-session"
    });

    expect(plan.map((item) => item.track.id)).toContain(11);
    expect(plan.map((item) => item.track.id)).not.toContain(12);
    expect(plan.map((item) => item.track.id)).toContain(13);
    expect(plan.findIndex((item) => item.track.id === 11)).toBeGreaterThan(
      plan.findIndex((item) => item.track.id === 14)
    );
  });

  it("boosts rainy-night friendly moods from environment context", () => {
    const planner = new RadioPlanner(() => 0.5);
    const plan = planner.plan(stats, profile, [], {
      environment: {
        dayPeriod: "late_night",
        weather: "rain",
        temperature: 18,
        location: { latitude: 31.23, longitude: 121.47, label: "Shanghai" },
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan[0]?.track.id).toBe(2);
    expect(plan[0]?.reason).toContain("雨天");
    expect(plan[0]?.reason).toContain("深夜");
  });

  it("caps a ten-track window at two qualified exploration picks", () => {
    const planner = new RadioPlanner(() => 0.5);
    const familiarStats: TrackStat[] = Array.from({ length: 10 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Familiar ${index + 1}`,
        artists: [`Known ${index + 1}`],
        moodTag: "warm"
      },
      playCount: 20 - index
    }));
    const candidates: RecommendationCandidate[] = Array.from({ length: 6 }, (_, index) => ({
      track: {
        id: 100 + index,
        title: `Explore ${index + 1}`,
        artists: [`New ${index + 1}`],
        moodTag: "warm"
      },
      source: index % 2 === 0 ? "ncm_daily" : "style_search",
      tags: [{ category: "style", value: `Style ${index + 1}` }],
      relevanceScore: 1 - index * 0.05,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates,
      environment: {
        dayPeriod: "evening",
        weather: "clear",
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan).toHaveLength(10);
    expect(plan.filter((item) => item.bucket === "familiar")).toHaveLength(8);
    expect(plan.filter((item) => item.bucket === "explore")).toHaveLength(2);
    expect(plan.map((item) => item.bucket)).toEqual([
      "familiar", "familiar", "familiar", "familiar", "explore",
      "familiar", "familiar", "familiar", "familiar", "explore"
    ]);
  });

  it("does not force a weak search candidate into an otherwise healthy queue", () => {
    const planner = new RadioPlanner(() => 0);
    const familiarStats: TrackStat[] = Array.from({ length: 10 }, (_, index) => ({
      track: { id: index + 1, title: `Known ${index + 1}`, artists: [`Artist ${index + 1}`] },
      playCount: 20 - index
    }));
    const weakCandidate: RecommendationCandidate = {
      track: { id: 300, title: "Unrelated Result", artists: ["Remote Artist"], moodTag: "unknown" },
      source: "context_search",
      tags: [],
      relevanceScore: 0.6,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates: [weakCandidate],
      environment: {
        dayPeriod: "afternoon",
        weather: "storm",
        updatedAt: new Date().toISOString()
      }
    });

    expect(plan).toHaveLength(10);
    expect(plan.every((item) => item.bucket === "familiar")).toBe(true);
  });

  it("uses daily recommendations for bootstrap without letting broad search exceed twenty percent", () => {
    const planner = new RadioPlanner(() => 0.5);
    const familiarStats: TrackStat[] = Array.from({ length: 2 }, (_, index) => ({
      track: { id: index + 1, title: `Known ${index + 1}`, artists: [`Artist ${index + 1}`] },
      playCount: 2 - index
    }));
    const daily: RecommendationCandidate[] = Array.from({ length: 3 }, (_, index) => ({
      track: { id: 100 + index, title: `Daily ${index + 1}`, artists: [`Daily Artist ${index + 1}`] },
      source: "ncm_daily",
      tags: [],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));
    const search: RecommendationCandidate[] = Array.from({ length: 6 }, (_, index) => ({
      track: { id: 200 + index, title: `Search ${index + 1}`, artists: [`Search Artist ${index + 1}`] },
      source: "context_search",
      tags: [],
      relevanceScore: 1,
      discoveredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }));

    const plan = planner.plan(familiarStats, profile, [], {
      windowSize: 10,
      candidates: [...daily, ...search]
    });

    expect(plan.filter((item) => item.source === "context_search").length).toBeLessThanOrEqual(2);
    expect(plan.filter((item) => item.source === "ncm_daily")).toHaveLength(3);
    expect(plan).toHaveLength(5);
  });
});
