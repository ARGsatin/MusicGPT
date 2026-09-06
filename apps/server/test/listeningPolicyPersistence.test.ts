import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ListeningPolicy } from "../src/listeningPolicy.js";
import { StateRepository } from "../src/stateRepository.js";

describe("ListeningPolicy SQLite persistence", () => {
  it("persists observations, signals and undo receipts across policy instances", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-policy-persistence-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const persistence = {
      appendListeningObservation: (observation: Parameters<StateRepository["appendListeningObservation"]>[0]) =>
        repo.appendListeningObservation(observation),
      replacePreferenceSignals: (signals: Parameters<StateRepository["replacePreferenceSignals"]>[0]) =>
        repo.replacePreferenceSignals(signals),
      saveRecommendationDecisions: (decisions: Parameters<StateRepository["saveRecommendationDecisions"]>[0]) =>
        repo.saveRecommendationDecisions(decisions),
      saveLearningReceipt: (receipt: Parameters<StateRepository["saveLearningReceipt"]>[0]) =>
        repo.saveLearningReceipt(receipt)
    };
    const policy = new ListeningPolicy({
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      id: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
      persistence
    });
    const receipt = policy.observe({
      observationId: "feedback-1",
      kind: "explicit_feedback",
      track: { id: 1, title: "Persisted", artists: ["Artist"] },
      reason: "dislike_track",
      scope: "long_term",
      at: "2026-08-25T07:59:00.000Z"
    });

    const restored = new ListeningPolicy({ state: repo.loadListeningPolicyState(), persistence });
    expect(restored.profile().signals).toEqual([
      expect.objectContaining({ source: "explicit", targetType: "recording" })
    ]);
    expect(repo.getLearningReceipt(receipt.undoToken)).toMatchObject({ receiptId: receipt.receiptId });
  });

  it("accepts one final outcome per playback and expires temporary intents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-outcome-idempotency-"));
    const repo = new StateRepository(path.join(dir, "state.db"));
    const outcome = {
      playbackId: "playback-1",
      trackId: "ncm:1",
      outcome: "completed" as const,
      listenedMs: 180_000,
      durationMs: 200_000,
      at: "2026-08-25T08:00:00.000Z"
    };

    expect(repo.recordPlaybackOutcome(outcome)).toBe(true);
    expect(repo.recordPlaybackOutcome(outcome)).toBe(false);
    repo.upsertSessionIntent({
      intentId: "intent-1",
      value: "安静",
      scope: "session",
      createdAt: "2026-08-25T07:00:00.000Z",
      updatedAt: "2026-08-25T07:00:00.000Z",
      expiresAt: "2026-08-25T09:00:00.000Z"
    });
    expect(repo.getActiveSessionIntents("2026-08-25T08:00:00.000Z")).toHaveLength(1);
    expect(repo.expireSessionIntents("2026-08-25T10:00:00.000Z")).toBe(1);
    expect(repo.getActiveSessionIntents("2026-08-25T10:00:00.000Z")).toEqual([]);
  });
});
