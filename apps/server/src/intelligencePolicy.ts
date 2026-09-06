import type { IntelligencePolicyMode, IntelligencePolicyStatus } from "@musicgpt/shared";

const POLICY_VERSION = "listening-policy-v1";
const SHADOW_MIN_SAMPLE_COUNT = 50;
const SHADOW_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const ADAPTIVE_PROTECTION_PLAYS = 50;

export interface IntelligencePolicyState {
  mode: IntelligencePolicyMode;
  shadowStartedAt: string;
  shadowSampleCount: number;
  manualRuleViolations?: number;
  duplicateRecordings?: number;
  quotaGuardrailFailures?: number;
  explicitConstraintFailures?: number;
  exceptionalDecisions?: number;
  adaptiveProtectionRemaining?: number;
  fallbackReason?: string;
}

export interface IntelligencePolicyPersistence {
  load(): IntelligencePolicyState | undefined;
  save(state: IntelligencePolicyState): void;
}

export interface ShadowDecisionAudit {
  manualRuleViolations: number;
  duplicateRecordings: number;
  quotaGuardrailSatisfied: boolean;
  explicitConstraintsSatisfied: boolean;
  exceptional: boolean;
}

export interface AdaptivePlaybackAudit {
  manualRuleViolation: boolean;
  playbackErrorRate: number;
  earlySkipRate: number;
  baselineEarlySkipRate: number;
}

export class IntelligencePolicyController {
  private state: IntelligencePolicyState;
  private readonly now: () => Date;
  private readonly environmentMode: IntelligencePolicyMode | undefined;

  constructor(
    private readonly persistence: IntelligencePolicyPersistence,
    options: { environmentMode?: IntelligencePolicyMode; now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.environmentMode = options.environmentMode;
    const existing = persistence.load();
    this.state = existing ?? {
      mode: "shadow",
      shadowStartedAt: this.now().toISOString(),
      shadowSampleCount: 0
    };
    if (!existing) persistence.save(this.state);
  }

  mode(): IntelligencePolicyMode {
    return this.environmentMode ?? this.state.mode;
  }

  status(): IntelligencePolicyStatus {
    return {
      mode: this.mode(),
      version: POLICY_VERSION,
      shadowSampleCount: this.state.shadowSampleCount,
      shadowStartedAt: this.state.shadowStartedAt,
      environmentOverride: this.environmentMode !== undefined,
      ...(this.state.adaptiveProtectionRemaining !== undefined
        ? { adaptiveProtectionRemaining: this.state.adaptiveProtectionRemaining }
        : {}),
      ...(this.state.fallbackReason ? { fallbackReason: this.state.fallbackReason } : {})
    };
  }

  recordShadowDecision(audit: ShadowDecisionAudit): void {
    if (this.mode() !== "shadow") return;
    if (!audit.exceptional && this.state.fallbackReason === "ranking_failure") {
      delete this.state.fallbackReason;
    }
    this.state.shadowSampleCount += 1;
    this.state.manualRuleViolations = (this.state.manualRuleViolations ?? 0) + audit.manualRuleViolations;
    this.state.duplicateRecordings = (this.state.duplicateRecordings ?? 0) + audit.duplicateRecordings;
    this.state.quotaGuardrailFailures =
      (this.state.quotaGuardrailFailures ?? 0) + (audit.quotaGuardrailSatisfied ? 0 : 1);
    this.state.explicitConstraintFailures =
      (this.state.explicitConstraintFailures ?? 0) + (audit.explicitConstraintsSatisfied ? 0 : 1);
    this.state.exceptionalDecisions = (this.state.exceptionalDecisions ?? 0) + (audit.exceptional ? 1 : 0);

    if (!this.environmentMode && this.shadowGateSatisfied()) {
      this.state.mode = "adaptive";
      this.state.adaptiveProtectionRemaining = ADAPTIVE_PROTECTION_PLAYS;
      delete this.state.fallbackReason;
    }
    this.persistence.save(this.state);
  }

  recordAdaptivePlayback(audit: AdaptivePlaybackAudit): void {
    if (this.mode() !== "adaptive") return;
    const fallbackReason = audit.manualRuleViolation
      ? "manual_rule_violation"
      : audit.playbackErrorRate > 0.02
        ? "playback_error_rate"
        : audit.earlySkipRate - audit.baselineEarlySkipRate > 0.1
          ? "early_skip_rate"
          : undefined;

    if (fallbackReason && !this.environmentMode) {
      this.state.mode = "shadow";
      this.state.fallbackReason = fallbackReason;
      this.state.shadowStartedAt = this.now().toISOString();
      this.state.shadowSampleCount = 0;
      this.state.manualRuleViolations = 0;
      this.state.duplicateRecordings = 0;
      this.state.quotaGuardrailFailures = 0;
      this.state.explicitConstraintFailures = 0;
      this.state.exceptionalDecisions = 0;
      delete this.state.adaptiveProtectionRemaining;
      this.persistence.save(this.state);
      return;
    }

    if ((this.state.adaptiveProtectionRemaining ?? 0) > 0) {
      this.state.adaptiveProtectionRemaining = Math.max(
        0,
        (this.state.adaptiveProtectionRemaining ?? 0) - 1
      );
      this.persistence.save(this.state);
    }
  }

  recordRankingFailure(reason = "ranking_failure"): void {
    this.state.fallbackReason = reason;
    this.persistence.save(this.state);
  }

  private shadowGateSatisfied(): boolean {
    const startedAt = Date.parse(this.state.shadowStartedAt);
    const oldEnough = Number.isFinite(startedAt) && this.now().getTime() - startedAt >= SHADOW_MIN_AGE_MS;
    const exceptionRate = (this.state.exceptionalDecisions ?? 0) / Math.max(1, this.state.shadowSampleCount);
    return (
      oldEnough &&
      this.state.shadowSampleCount >= SHADOW_MIN_SAMPLE_COUNT &&
      (this.state.manualRuleViolations ?? 0) === 0 &&
      (this.state.duplicateRecordings ?? 0) === 0 &&
      (this.state.quotaGuardrailFailures ?? 0) === 0 &&
      (this.state.explicitConstraintFailures ?? 0) === 0 &&
      exceptionRate < 0.01
    );
  }
}
