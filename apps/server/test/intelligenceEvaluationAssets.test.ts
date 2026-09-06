import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { runOfflineIntelligenceEvaluation } from "../evals/offline-intelligence-evaluator.js";
import {
  hashLiveEvaluationCorpus,
  LIVE_CHANNEL_SET,
  LIVE_EVALUATOR_VERSION
} from "../evals/live-intelligence-evaluator.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const evalDir = path.resolve(testDir, "../evals");
const workspaceRoot = path.resolve(testDir, "../../..");

const categoryQuotas = {
  direct_or_compound_command: 40,
  reference_or_clarification: 30,
  temporary_or_long_term_correction: 30,
  contextual_recommendation: 30,
  multi_source_or_failure: 20
} as const;

type Category = keyof typeof categoryQuotas;

interface ChannelExpectation {
  endpoint: "/api/chat/stream" | "/api/music/commands";
  input: string;
  expected: {
    action: string;
    outcome: "executed" | "answered" | "needs_confirmation" | "failed";
    stepActions: string[];
    sideEffects: string[];
    assertions: string[];
  };
}

interface IntelligenceTrajectory {
  id: string;
  category: Category;
  risk: "normal" | "high";
  text: ChannelExpectation;
  voice: ChannelExpectation;
}

interface EvaluationModule {
  intelligenceTrajectories: IntelligenceTrajectory[];
  highRiskReleaseCases: IntelligenceTrajectory[];
}

async function loadEvaluationModule(): Promise<EvaluationModule> {
  const moduleUrl = pathToFileURL(path.join(evalDir, "intelligence-trajectories.mjs")).href;
  return await import(moduleUrl) as EvaluationModule;
}

describe("fixed intelligence evaluation assets", () => {
  it("locks the 150-trajectory category quotas and unique stable IDs", async () => {
    const { intelligenceTrajectories } = await loadEvaluationModule();

    expect(runOfflineIntelligenceEvaluation).toBeTypeOf("function");
    expect(intelligenceTrajectories).toHaveLength(150);
    expect(new Set(intelligenceTrajectories.map((item) => item.id)).size).toBe(150);
    expect(intelligenceTrajectories.every((item) => /^(cmd|ref|fix|ctx|src)-\d{3}$/.test(item.id))).toBe(true);

    const actualQuotas = Object.fromEntries(
      Object.keys(categoryQuotas).map((category) => [
        category,
        intelligenceTrajectories.filter((item) => item.category === category).length
      ])
    );
    expect(actualQuotas).toEqual(categoryQuotas);
  });

  it("defines text and voice expectations at public observable seams for every trajectory", async () => {
    const { intelligenceTrajectories } = await loadEvaluationModule();
    const allAssertions = new Set<string>();
    const validMusicActions = new Set([
      "skip", "pause", "resume", "replan", "play_specific", "play_by_description", "play_atmosphere",
      "comment_current", "noop", "replay", "like", "unlike", "query_current", "query_queue",
      "update_session_intent", "update_long_term_preference"
    ]);

    for (const trajectory of intelligenceTrajectories) {
      expect(trajectory.text.endpoint).toBe("/api/chat/stream");
      expect(trajectory.voice.endpoint).toBe("/api/music/commands");
      expect(trajectory.text.input.trim().length).toBeGreaterThan(0);
      expect(trajectory.voice.input.trim().length).toBeGreaterThan(0);
      expect(trajectory.text.expected.action.length).toBeGreaterThan(0);
      expect(trajectory.voice.expected.action).toBe(trajectory.text.expected.action);
      expect(trajectory.text.expected.outcome).toBe(trajectory.voice.expected.outcome);
      expect(trajectory.text.expected.stepActions).toEqual(trajectory.voice.expected.stepActions);
      expect(trajectory.text.expected.sideEffects).toEqual(trajectory.voice.expected.sideEffects);
      expect(trajectory.text.expected.stepActions.every((action) => validMusicActions.has(action))).toBe(true);
      expect(trajectory.text.expected.assertions.length).toBeGreaterThan(0);
      expect(trajectory.voice.expected.assertions.length).toBeGreaterThan(0);
      expect(trajectory.text.expected.assertions.every((field) => field.startsWith("result.response."))).toBe(true);
      expect(trajectory.voice.expected.assertions.every((field) => field.startsWith("result."))).toBe(true);
      trajectory.text.expected.assertions.forEach((field) => allAssertions.add(field));
    }

    for (const requiredSeam of [
      "result.response.now.track",
      "result.response.now.queue",
      "result.response.learningReceipt",
      "result.response.clarification"
    ]) {
      expect(allAssertions.has(requiredSeam), `missing public seam ${requiredSeam}`).toBe(true);
    }
  });

  it("keeps the real-model release set at exactly 25 high-risk cases", async () => {
    const { intelligenceTrajectories, highRiskReleaseCases } = await loadEvaluationModule();
    const corpusIds = new Set(intelligenceTrajectories.map((item) => item.id));

    expect(highRiskReleaseCases).toHaveLength(25);
    expect(new Set(highRiskReleaseCases.map((item) => item.id)).size).toBe(25);
    expect(highRiskReleaseCases.every((item) => item.risk === "high" && corpusIds.has(item.id))).toBe(true);

    const cache = JSON.parse(fs.readFileSync(path.join(evalDir, "high-risk-release-cache.json"), "utf8")) as {
      schemaVersion: number;
      evaluatorVersion: string;
      corpusHash: string;
      channelSet: string[];
      results: Array<Record<string, unknown> & { caseId: string; status: string }>;
    };
    expect(cache).toMatchObject({
      schemaVersion: 2,
      evaluatorVersion: LIVE_EVALUATOR_VERSION,
      corpusHash: hashLiveEvaluationCorpus(highRiskReleaseCases),
      channelSet: LIVE_CHANNEL_SET
    });
    expect(cache.results).toHaveLength(25);
    expect(cache.results.map((item) => item.caseId)).toEqual(highRiskReleaseCases.map((item) => item.id));
    expect(cache.results.every((item) => ["pending", "passed", "failed"].includes(item.status))).toBe(true);
    expect(cache.results.every((item) =>
      !("utterance" in item) && !("input" in item) && !("response" in item) && !("apiKey" in item)
    )).toBe(true);
  });

  it("executes all 150 trajectories through both offline command channels by default", () => {
    const stdout = execFileSync(
      process.execPath,
      [path.join(workspaceRoot, "scripts/evaluate-intelligence.mjs")],
      { cwd: workspaceRoot, encoding: "utf8" }
    );
    const summary = JSON.parse(stdout) as Record<string, unknown>;

    expect(summary).toMatchObject({
      mode: "offline",
      total: 150,
      executed: 150,
      channelExecutions: 300,
      fallbackPlannerChannelExecutions: 12,
      passed: 150,
      failed: 0,
      releaseReady: true
    });
  });

  it("returns a non-zero command when one executed offline trajectory fails", () => {
    const run = spawnSync(
      process.execPath,
      [path.join(workspaceRoot, "scripts/evaluate-intelligence.mjs"), "--simulate-failure=cmd-001"],
      { cwd: workspaceRoot, encoding: "utf8" }
    );
    expect(run.status).not.toBe(0);
    const summary = JSON.parse(run.stdout) as {
      executed: number;
      passed: number;
      failed: number;
      failedCases: Array<{ caseId: string }>;
    };
    expect(summary).toMatchObject({ executed: 150, passed: 149, failed: 1 });
    expect(summary.failedCases).toEqual(expect.arrayContaining([{ caseId: "cmd-001", channels: expect.any(Array) }]));
  }, 15_000);

  it("enforces at least 92% success with a zero unsafe-action rate", async () => {
    const { highRiskReleaseCases } = await loadEvaluationModule();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-intelligence-eval-"));
    const cachePath = path.join(temporaryDirectory, "cache.json");
    const baseCache = {
      schemaVersion: 2,
      evaluatorVersion: LIVE_EVALUATOR_VERSION,
      corpusHash: hashLiveEvaluationCorpus(highRiskReleaseCases),
      channelSet: LIVE_CHANNEL_SET,
      policyVersion: "test",
      provider: "test",
      model: "cached-test",
      generatedAt: "2026-08-25T00:00:00.000Z",
      source: "test",
      results: highRiskReleaseCases.map((item, index) => ({
        caseId: item.id,
        status: index < 23 ? "passed" : "failed",
        actionMatches: index < 23,
        seamMatches: index < 23,
        unsafeAction: false,
        textPassed: index < 23,
        voicePassed: index < 23,
        channelConsistent: true,
        ...(index < 23 ? {} : { errorCode: "action_mismatch" })
      }))
    };
    fs.writeFileSync(cachePath, JSON.stringify(baseCache), "utf8");

    const thresholdSummary = JSON.parse(execFileSync(
      process.execPath,
      [path.join(workspaceRoot, "scripts/evaluate-intelligence.mjs"), "--cache-only", `--cache=${cachePath}`],
      { cwd: workspaceRoot, encoding: "utf8" }
    )) as { successRate: number; errorActionRate: number; releaseReady: boolean };
    expect(thresholdSummary).toMatchObject({ successRate: 0.92, errorActionRate: 0, releaseReady: true });

    baseCache.results[0] = {
      caseId: highRiskReleaseCases[0]?.id ?? "cmd-009",
      status: "passed",
      actionMatches: true,
      seamMatches: true,
      unsafeAction: true,
      textPassed: true,
      voicePassed: true,
      channelConsistent: true,
      errorCode: "unsafe_action"
    };
    fs.writeFileSync(cachePath, JSON.stringify(baseCache), "utf8");
    const unsafeSummary = JSON.parse(execFileSync(
      process.execPath,
      [path.join(workspaceRoot, "scripts/evaluate-intelligence.mjs"), "--cache-only", `--cache=${cachePath}`],
      { cwd: workspaceRoot, encoding: "utf8" }
    )) as { errorActionRate: number; releaseReady: boolean };
    expect(unsafeSummary.errorActionRate).toBeGreaterThan(0);
    expect(unsafeSummary.releaseReady).toBe(false);
  });
});
