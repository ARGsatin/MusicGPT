import type OpenAI from "openai";

import { describe, expect, it } from "vitest";

import type { MusicActionPlan } from "@musicgpt/shared";
import type { LiveEvaluationCase } from "../evals/live-intelligence-evaluator.js";
import { runLiveIntelligenceEvaluation } from "../evals/live-intelligence-evaluator.js";
import { OpenAiDjAssistant } from "../src/aiDjAssistant.js";

interface PlannerPayload {
  message: string;
  nowTrack?: { title?: string };
  queue?: Array<{ title?: string }>;
  recentMessages?: unknown[];
}

describe("isolated live intelligence evaluator", () => {
  it("checks the hard constraints actually applied by MusicCommand", async () => {
    const cases = Array.from({ length: 25 }, (_value, index) => evaluationCase(index));
    const target = cases[0]!;
    target.id = "cmd-026";
    target.fixture = {
      actions: [{ action: "play_by_description", description: "爵士", confidence: 1 }],
      constraints: [],
      references: [],
      confidence: 1
    };
    for (const channel of ["text", "voice"] as const) {
      target[channel].input = "来点爵士，但不要纯器乐";
      target[channel].expected = {
        action: "play_by_description",
        outcome: "executed",
        stepActions: ["play_by_description"],
        sideEffects: ["playback"],
        assertions: []
      };
    }

    const evaluation = await runLiveIntelligenceEvaluation({
      assistant: {
        plan: async (input) => cases.find((item) => item.text.input === input)!.fixture,
        status: () => ({ configured: true, provider: "fixture" })
      },
      cases,
      timeoutMs: 5_000
    });

    expect(evaluation.results[0]).toMatchObject({ status: "passed", unsafeAction: false });
  });

  it("rejects incorrectly scoped learning even when action and receipt fields match", async () => {
    const cases = Array.from({ length: 25 }, (_value, index) => evaluationCase(index));
    const target = cases[0]!;
    target.id = "fix-003";
    target.fixture = { actions: [{ action: "update_session_intent", feedbackReason: "wrong_for_now", scope: "long_term" }], constraints: [], references: [], confidence: 1 };
    for (const channel of ["text", "voice"] as const) {
      target[channel].input = "这首只是现在不合适";
      target[channel].expected = { action: "update_session_intent", outcome: "executed", stepActions: ["update_session_intent"], sideEffects: ["queue", "learning"], assertions: [] };
    }
    const evaluation = await runLiveIntelligenceEvaluation({
      assistant: { plan: async (input) => cases.find((item) => item.text.input === input)!.fixture, status: () => ({ configured: true, provider: "fixture" }) },
      cases, timeoutMs: 5000
    });
    expect(evaluation.results[0]).toMatchObject({ status: "failed", unsafeAction: true, errorCodes: expect.arrayContaining(["wrong_learning_scope"]) });
  });
  it("runs every paid plan through a real OpenAiDjAssistant with a fresh fixed command context", async () => {
    const cases = Array.from({ length: 25 }, (_value, index) => evaluationCase(index));
    const planByInput = new Map(
      cases.map((item) => [item.text.input, item.fixture] as const)
    );
    const plannerPayloads: PlannerPayload[] = [];
    const fakeClient = {
      chat: {
        completions: {
          create: async (request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming) => {
            const userContent = request.messages.at(-1)?.content;
            if (typeof userContent !== "string") throw new Error("missing_test_payload");
            const payload = JSON.parse(userContent) as PlannerPayload;
            plannerPayloads.push(payload);
            const plan = planByInput.get(payload.message);
            if (!plan) throw new Error("unknown_test_case");
            return completion(plan);
          }
        }
      }
    };
    const assistant = new OpenAiDjAssistant({
      client: fakeClient as never,
      model: "fixture-live-model",
      provider: "openai"
    });

    const evaluation = await runLiveIntelligenceEvaluation({
      assistant,
      cases,
      timeoutMs: 5_000
    });

    expect(evaluation.results).toHaveLength(25);
    expect(evaluation).toMatchObject({
      schemaVersion: 2,
      evaluatorVersion: "isolated-music-command-v6",
      channelSet: ["text", "voice"],
      provider: "openai",
      model: "fixture-live-model",
      modelPlanExecutions: 25,
      commandChannelExecutions: 50
    });
    expect(evaluation.corpusHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      evaluation.results.every((item) => item.status === "passed"),
      JSON.stringify(evaluation.results.filter((item) => item.status === "failed"))
    ).toBe(true);
    expect(plannerPayloads).toHaveLength(25);
    expect(new Set(plannerPayloads.map((item) => item.nowTrack?.title))).toEqual(new Set(["Current Fixture"]));
    expect(new Set(plannerPayloads.map((item) => JSON.stringify(item.queue?.map((track) => track.title))))).toEqual(
      new Set([JSON.stringify(["Queue One", "Queue Two", "Queue Three"])])
    );
    expect(plannerPayloads.every((item) => item.recentMessages?.length === 0)).toBe(true);
    expect(JSON.stringify(evaluation)).not.toMatch(/能听一首陈奕迅吗|Current Fixture|apiKey|authorization|cookie/iu);
    expect(Object.keys(evaluation.results[0] ?? {}).sort()).toEqual([
      "actionMatches",
      "caseId",
      "channelConsistent",
      "seamMatches",
      "status",
      "textPassed",
      "unsafeAction",
      "voicePassed"
    ]);
  });
});

function evaluationCase(index: number): LiveEvaluationCase {
  const action = index % 2 === 0 ? "pause" : "resume";
  const input = action === "pause"
    ? `暂停音乐，评测编号 ${index}`
    : `继续播放，评测编号 ${index}`;
  const fixture: MusicActionPlan = {
    actions: [{ action, confidence: 1 }],
    constraints: [],
    references: [],
    confidence: 1
  };
  return {
    id: `isolated-${String(index).padStart(3, "0")}`,
    category: "isolation_fixture",
    fixture,
    text: {
      endpoint: "/api/chat/stream",
      input,
      expected: {
        action,
        outcome: "executed",
        stepActions: [action],
        sideEffects: ["playback"],
        assertions: ["result.response.action", "result.response.now.track"]
      }
    },
    voice: {
      endpoint: "/api/music/commands",
      input,
      expected: {
        action,
        outcome: "executed",
        stepActions: [action],
        sideEffects: ["playback"],
        assertions: ["result.action", "result.now.track"]
      }
    }
  };
}

function completion(plan: MusicActionPlan): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "fixture-completion",
    object: "chat.completion",
    created: 0,
    model: "fixture-live-model",
    choices: [{
      index: 0,
      finish_reason: "stop",
      logprobs: null,
      message: { role: "assistant", content: JSON.stringify(plan), refusal: null }
    }]
  };
}
