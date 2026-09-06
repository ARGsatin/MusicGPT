import { describe, expect, it } from "vitest";

import { IntelligencePolicyController } from "../src/intelligencePolicy.js";

describe("IntelligencePolicyController", () => {
  it("defaults the first upgrade to shadow and honors an environment override", () => {
    const persisted: unknown[] = [];
    const controller = new IntelligencePolicyController({
      load: () => undefined,
      save: (state) => persisted.push(state)
    });

    expect(controller.status()).toMatchObject({ mode: "shadow", shadowSampleCount: 0 });
    expect(persisted).toHaveLength(1);

    const forced = new IntelligencePolicyController(
      { load: () => ({ mode: "adaptive", shadowStartedAt: "2026-01-01T00:00:00.000Z", shadowSampleCount: 80 }), save: () => undefined },
      { environmentMode: "legacy" }
    );
    expect(forced.status()).toMatchObject({ mode: "legacy", environmentOverride: true });
  });

  it("promotes shadow only after seven days, fifty decisions, and perfect hard guardrails", () => {
    let state: Parameters<ConstructorParameters<typeof IntelligencePolicyController>[0]["save"]>[0] | undefined;
    const now = new Date("2026-08-25T12:00:00.000Z");
    const controller = new IntelligencePolicyController(
      {
        load: () => ({
          mode: "shadow",
          shadowStartedAt: "2026-08-18T11:59:59.000Z",
          shadowSampleCount: 49
        }),
        save: (next) => {
          state = next;
        }
      },
      { now: () => now }
    );

    controller.recordShadowDecision({
      manualRuleViolations: 0,
      duplicateRecordings: 0,
      quotaGuardrailSatisfied: true,
      explicitConstraintsSatisfied: true,
      exceptional: false
    });

    expect(controller.status()).toMatchObject({ mode: "adaptive", adaptiveProtectionRemaining: 50 });
    expect(state?.mode).toBe("adaptive");
  });

  it("falls back to shadow during adaptive protection when a hard rule is violated", () => {
    const controller = new IntelligencePolicyController({
      load: () => ({
        mode: "adaptive",
        shadowStartedAt: "2026-08-01T00:00:00.000Z",
        shadowSampleCount: 80,
        adaptiveProtectionRemaining: 49
      }),
      save: () => undefined
    });

    controller.recordAdaptivePlayback({
      manualRuleViolation: true,
      playbackErrorRate: 0,
      earlySkipRate: 0.1,
      baselineEarlySkipRate: 0.1
    });

    expect(controller.status()).toMatchObject({
      mode: "shadow",
      fallbackReason: "manual_rule_violation"
    });
  });
});
