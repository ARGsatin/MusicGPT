import { createHash, randomUUID } from "node:crypto";

import type {
  DayPeriod,
  MusicTag,
  PlayEvent,
  RecommendationCandidate,
  RecommendationEvidence as SharedRecommendationEvidence,
  RecommendationSource,
  RoutineBlock,
  TasteManualRules,
  TasteProfile,
  TasteSignalMutationAction,
  Track,
  TrackStat,
  WeatherKind,
  SessionIntent,
  ListeningConstraint
} from "@musicgpt/shared";

import { getTrackKey, normalizeTrackIdentity, normalizeTrackReference } from "./musicCatalog.js";
import { isEligibleRecommendationTrack } from "./recommendationQuality.js";
import { inferTrackTags } from "./trackTags.js";

export const LISTENING_POLICY_VERSION = "1";

export interface DailyPlanQuotas {
  morningExplore: number;
  afternoonSoft: number;
  afternoonClassical: number;
  eveningMemory: number;
}

export const DEFAULT_DAILY_PLAN_QUOTAS: Readonly<DailyPlanQuotas> = {
  morningExplore: 4,
  afternoonSoft: 7,
  afternoonClassical: 2,
  eveningMemory: 8
};

export const DAILY_PLAN_QUOTA_GUARDS = {
  morningExplore: { min: 2, max: 5 },
  afternoonSoft: { min: 5, max: 8 },
  afternoonClassical: { min: 1, max: 3 },
  eveningMemory: { min: 6, max: 9 }
} as const;

export type ListeningFeedbackReason =
  | "dislike_track"
  | "less_this_artist"
  | "wrong_for_now"
  | "overplayed"
  | "bad_version"
  | "playback_problem";

export type LearningScope = "session" | "day" | "long_term";
export type PlaybackOutcome = "completed" | "skipped" | "abandoned" | "playback_error" | "replay";
export type PreferenceSignalTarget = "recording" | "artist" | "version" | "tag" | "quota";
export type PreferenceSignalSource = "manual" | "explicit" | "implicit" | "baseline";

export interface ListeningObservation {
  observationId: string;
  kind: "explicit_feedback" | "playback_outcome" | "signal_correction" | "undo";
  track: Track;
  at: string;
  sessionId?: string;
  decisionId?: string;
  reason?: ListeningFeedbackReason;
  scope?: LearningScope;
  outcome?: PlaybackOutcome;
  listenedMs?: number;
  durationMs?: number;
  dayPeriod?: DayPeriod;
  activeSkip?: boolean;
  reversesObservationId?: string;
  targetSignalId?: string;
  correction?: TasteSignalMutationAction;
  previousSignals?: PreferenceSignal[];
  /** Snapshot for reversible favorite mutations kept separate from taste. */
  favoriteBefore?: boolean;
  favoriteAfter?: boolean;
  /** Queue-context snapshot so undo restores the previous temporary intent. */
  sessionIntentsBefore?: SessionIntent[];
  sessionIntentAfter?: SessionIntent;
  structuredPreferences?: Array<Pick<
    PreferenceSignal,
    "targetType" | "targetKey" | "direction" | "strength" | "label"
  >>;
}

export interface PreferenceSignal {
  signalId: string;
  source: PreferenceSignalSource;
  targetType: PreferenceSignalTarget;
  targetKey: string;
  direction: "positive" | "negative" | "neutral";
  strength: number;
  scope: LearningScope;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  expiresAt?: string;
  observationIds: string[];
  label: string;
  value?: number;
  reversedAt?: string;
  reversedByObservationId?: string;
}

export type RecommendationEvidence = SharedRecommendationEvidence;

export interface LearningReceipt {
  receiptId: string;
  observationId: string;
  scope: LearningScope;
  changedSignals: PreferenceSignal[];
  replacedQueueCount: number;
  summary: string;
  undoToken: string;
  undoExpiresAt: string;
  undoneAt?: string;
  operations?: Record<string, "added" | "updated" | "removed">;
}

export interface ListeningPolicyProfile {
  generatedAt: string;
  policyVersion: string;
  signals: PreferenceSignal[];
  quotas: DailyPlanQuotas;
}

export interface ListeningRankContext {
  sessionId?: string;
  period?: DayPeriod;
  weather?: WeatherKind;
  routine?: RoutineBlock[];
  desiredMood?: string;
  contextTags?: MusicTag[];
  constraints?: ListeningConstraint[];
}

export interface ListeningRankRequest {
  stats: TrackStat[];
  candidates?: RecommendationCandidate[];
  profile: TasteProfile;
  rules: TasteManualRules;
  events?: PlayEvent[];
  context?: ListeningRankContext;
  allowAmbient?: boolean;
  limit?: number;
  now?: string;
  random?: () => number;
}

export interface RankedDecision {
  decisionId: string;
  recordingKey: string;
  track: Track;
  score: number;
  evidence: RecommendationEvidence[];
  policyVersion: string;
  bucket: "familiar" | "explore";
  source: RecommendationSource;
}

export interface RecommendationExplanation {
  decisionId: string;
  track: Track;
  summary: string;
  evidence: RecommendationEvidence[];
  policyVersion: string;
}

export interface ListeningPolicyState {
  observations: ListeningObservation[];
  signals: PreferenceSignal[];
  receipts?: LearningReceipt[];
}

export interface ListeningPolicyPersistence {
  appendListeningObservation?(observation: ListeningObservation): void;
  replacePreferenceSignals?(signals: PreferenceSignal[]): void;
  commitLearningMutation?(
    observation: ListeningObservation,
    signals: PreferenceSignal[],
    receipt: LearningReceipt
  ): void;
  saveRecommendationDecisions?(decisions: RankedDecision[]): void;
  saveLearningReceipt?(receipt: LearningReceipt): void;
}

export interface ListeningPolicyOptions {
  now?: () => Date;
  id?: () => string;
  state?: Partial<ListeningPolicyState>;
  persistence?: ListeningPolicyPersistence;
}

interface CandidateVariant {
  track: Track;
  stat?: TrackStat;
  source: RecommendationSource;
  relevanceScore: number;
}

export class ListeningPolicy {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly persistence: ListeningPolicyPersistence | undefined;
  private readonly observations = new Map<string, ListeningObservation>();
  private signals: PreferenceSignal[];
  private readonly explanations = new Map<string, RecommendationExplanation>();
  private readonly receipts = new Map<string, LearningReceipt>();

  constructor(options: ListeningPolicyOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.persistence = options.persistence;
    this.signals = [...(options.state?.signals ?? [])];
    for (const observation of options.state?.observations ?? []) {
      this.observations.set(observation.observationId, observation);
    }
    for (const receipt of options.state?.receipts ?? []) {
      this.receipts.set(receipt.undoToken, receipt);
    }
  }

  observe(observation: ListeningObservation): LearningReceipt {
    const existing = this.observations.get(observation.observationId);
    if (existing) {
      return [...this.receipts.values()].find((receipt) => receipt.observationId === existing.observationId) ??
        this.receiptFor(existing, []);
    }
    const normalized = { ...observation, track: normalizeTrackIdentity(observation.track) };
    const signalsBefore = this.signals.map(cloneSignal);
    const previousSignals = new Map(this.signals.map((signal) => [signal.signalId, cloneSignal(signal)]));
    this.observations.set(normalized.observationId, normalized);
    let receipt: LearningReceipt | undefined;
    try {
      const changedSignals = normalized.kind === "explicit_feedback"
        ? this.applyExplicitFeedback(normalized)
        : normalized.kind === "playback_outcome"
          ? this.applyPlaybackOutcome(normalized)
          : normalized.kind === "signal_correction"
            ? this.applySignalCorrection(normalized)
          : [];
      if (normalized.kind === "playback_outcome") {
        changedSignals.push(...this.maybeAdjustQuotas(normalized));
      }
      receipt = this.receiptFor(
        normalized,
        changedSignals,
        Object.fromEntries(changedSignals.map((signal) => [
          signal.signalId,
          signalChangeOperation(previousSignals.get(signal.signalId), signal)
        ]))
      );
      this.receipts.set(receipt.undoToken, receipt);
      this.persistLearningMutation(normalized, receipt);
      return receipt;
    } catch (error) {
      this.observations.delete(normalized.observationId);
      this.signals = signalsBefore;
      if (receipt) this.receipts.delete(receipt.undoToken);
      throw error;
    }
  }

  rank(request: ListeningRankRequest): RankedDecision[] {
    const at = request.now ? new Date(request.now) : this.now();
    const variants = collectCandidateVariants(request.stats, request.candidates ?? []);
    const maxPlayCount = Math.max(1, ...request.stats.map((stat) => stat.playCount));
    const decisions: RankedDecision[] = [];
    const grouped = new Map<string, CandidateVariant[]>();
    for (const variant of variants) {
      if (!isEligibleRecommendationTrack(variant.track, request.allowAmbient)) continue;
      const recordingKey = variant.track.recordingKey!;
      const bucket = grouped.get(recordingKey) ?? [];
      bucket.push(variant);
      grouped.set(recordingKey, bucket);
    }

    for (const [recordingKey, recordingVariants] of grouped) {
      if (recordingVariants.some((variant) => isBlocked(variant.track, request.rules))) continue;
      const recordingStats = request.stats.filter((stat) =>
        normalizeTrackIdentity(stat.track).recordingKey === recordingKey
      );
      const recordingUnfamiliar = recordingStats.length === 0 ||
        recordingStats.every((stat) =>
          stat.playCount === 0 && !stat.likedAt && !stat.localFavoritedAt && !stat.lastPlayedAt
        );
      const activeSignals = this.activeSignals(recordingVariants, recordingKey, request.context?.sessionId, at);
      if (hasExplicitCooldown(activeSignals)) continue;
      const eventSignal = currentEventSignal(recordingVariants, request.events ?? [], at);
      if (eventSignal.hidden) continue;
      const explicitMultiplier = signalMultiplier(activeSignals.filter((signal) => signal.source === "explicit"));
      const implicitMultiplier = clampMultiplier(signalMultiplier(
        activeSignals.filter((signal) => signal.source === "implicit" && signal.targetType !== "version")
      ));
      const recordingManual = recordingManualMultiplier(recordingVariants.map((variant) => variant.track), request.rules);
      const scored = recordingVariants
        .filter((variant) => satisfiesListeningConstraints(variant.track, request.context?.constraints))
        .filter((variant) => !hasVersionCooldown(activeSignals, getTrackKey(variant.track)))
        .map((variant) => {
          const evidence: RecommendationEvidence[] = [];
          const manual = recordingManual;
          if (manual !== 1) {
            evidence.push({
              type: "manual_rule",
              label: manual > 1 ? "符合 taste.md 人工偏好" : "受 taste.md 人工规则降权",
              strength: Math.abs(manual - 1),
              correctable: false
            });
          }
          for (const signal of activeSignals.filter((entry) => entry.source === "explicit" && entry.targetType !== "version")) {
            evidence.push({
              type: "explicit_preference",
              label: signal.label,
              strength: signal.strength,
              correctable: true,
              signalId: signal.signalId
            });
          }
          for (const signal of activeSignals.filter((entry) => entry.source === "implicit" && entry.targetType !== "version")) {
            evidence.push({
              type: "implicit_behavior",
              label: signal.label,
              strength: signal.strength,
              correctable: true,
              signalId: signal.signalId
            });
          }
          if (eventSignal.multiplier < 1) {
            evidence.push({
              type: "implicit_behavior",
              label: eventSignal.label,
              strength: 1 - eventSignal.multiplier,
              correctable: true
            });
          }
          const playCount = recordingStats.reduce((total, stat) => total + stat.playCount, 0);
          const localFavorite = recordingStats.some((stat) => Boolean(stat.localFavoritedAt));
          const platformLike = recordingStats.some((stat) => Boolean(stat.likedAt));
          const baselineDeleted = activeSignals.some((signal) =>
            signal.source === "explicit" &&
            signal.targetType === "recording" &&
            signal.direction === "neutral" &&
            signal.label.startsWith("你已删除旧基线：")
          );
          const baseline = baselineDeleted
            ? 0
            : Math.min(1,
                (localFavorite ? 0.8 : 0) +
                (platformLike ? 0.6 : 0) +
                (playCount > 0 ? Math.min(0.35, (playCount / maxPlayCount) * 0.35) : 0)
              );
          if (baseline > 0) {
            evidence.push({
              type: "legacy_baseline",
              label: localFavorite ? "来自本地收藏" : platformLike ? "来自平台喜欢" : "来自既有播放记录",
              strength: baseline,
              correctable: true
            });
          }
          const profileScore = profileAffinity(variant.track, request.profile);
          const contextScore = contextAffinity(variant.track, request.context, recordingUnfamiliar);
          if (request.context?.desiredMood && contextScore > 0.55) {
            evidence.push({
              type: "session_intent",
              label: `符合当前“${request.context.desiredMood}”意图`,
              strength: contextScore,
              correctable: true
            });
          }
          const explore = recordingUnfamiliar;
          const sourceScore = sourceQuality(variant.source);
          if (explore) {
            evidence.push({
              type: "novelty",
              label: "这首录音还没有进入你的播放历史",
              strength: 0.5,
              correctable: false
            });
          }
          evidence.push({
            type: "source_availability",
            label: recommendationSourceLabel(variant.source),
            strength: sourceScore,
            correctable: false
          });
          const jitter = (request.random?.() ?? 0.5) * 0.02;
          const base = 0.2 + baseline * 0.25 + profileScore * 0.25 + contextScore * 0.25 +
            variant.relevanceScore * 0.1 + sourceScore * 0.05 + jitter;
          const learnedMultiplier = explicitMultiplier * implicitMultiplier * eventSignal.multiplier;
          const subordinateMultiplier = manual > 1
            ? Math.max(1, learnedMultiplier)
            : manual < 1
              ? Math.min(1, learnedMultiplier)
              : learnedMultiplier;
          return {
            variant,
            evidence: orderEvidence(evidence).slice(0, 3),
            explore,
            score: base * manual * subordinateMultiplier
          };
        })
        .sort((left, right) => right.score - left.score || getTrackKey(left.variant.track).localeCompare(getTrackKey(right.variant.track)));
      const best = scored[0];
      if (!best) continue;
      const decisionId = stableId([
        LISTENING_POLICY_VERSION,
        request.context?.period ?? "",
        request.context?.sessionId ?? "",
        recordingKey,
        getTrackKey(best.variant.track),
        best.score.toFixed(6)
      ].join("|"));
      const decision: RankedDecision = {
        decisionId,
        recordingKey,
        track: best.variant.track,
        score: Number(best.score.toFixed(4)),
        evidence: best.evidence,
        policyVersion: LISTENING_POLICY_VERSION,
        bucket: best.explore ? "explore" : "familiar",
        source: best.variant.source
      };
      decisions.push(decision);
      this.explanations.set(decisionId, {
        decisionId,
        track: decision.track,
        summary: decision.evidence.map((item) => item.label).join(" · ") || "基于当前候选质量",
        evidence: decision.evidence,
        policyVersion: LISTENING_POLICY_VERSION
      });
    }
    decisions.sort((left, right) => right.score - left.score || left.decisionId.localeCompare(right.decisionId));
    const output = request.limit === undefined ? decisions : decisions.slice(0, request.limit);
    this.persistence?.saveRecommendationDecisions?.(output);
    return output;
  }

  profile(): ListeningPolicyProfile {
    return {
      generatedAt: this.now().toISOString(),
      policyVersion: LISTENING_POLICY_VERSION,
      signals: this.signals.map((signal) => ({ ...signal, observationIds: [...signal.observationIds] })),
      quotas: this.quotaValues()
    };
  }

  explain(decisionId: string): RecommendationExplanation | undefined {
    const explanation = this.explanations.get(decisionId);
    return explanation ? { ...explanation, evidence: [...explanation.evidence] } : undefined;
  }

  /** Keep session-scoped evidence aligned with the same inactivity window as its intent. */
  extendSession(sessionId: string, expiresAt: string, updatedAt: string): void {
    const before = this.signals.map(cloneSignal);
    let changed = false;
    for (const signal of this.signals) {
      if (
        signal.scope !== "session" ||
        signal.sessionId !== sessionId ||
        signal.reversedAt ||
        !signal.expiresAt ||
        Date.parse(signal.expiresAt) >= Date.parse(expiresAt)
      ) continue;
      signal.expiresAt = expiresAt;
      signal.updatedAt = updatedAt;
      changed = true;
    }
    if (!changed) return;
    try {
      this.persistence?.replacePreferenceSignals?.(this.signals);
    } catch (error) {
      this.signals = before;
      throw error;
    }
  }

  private persistLearningMutation(observation: ListeningObservation, receipt: LearningReceipt): void {
    if (this.persistence?.commitLearningMutation) {
      this.persistence.commitLearningMutation(observation, this.signals, receipt);
      return;
    }
    this.persistence?.appendListeningObservation?.(observation);
    this.persistence?.replacePreferenceSignals?.(this.signals);
    this.persistence?.saveLearningReceipt?.(receipt);
  }

  undo(undoToken: string): LearningReceipt | undefined {
    const receipt = this.receipts.get(undoToken);
    const now = this.now();
    if (!receipt || receipt.undoneAt || Date.parse(receipt.undoExpiresAt) < now.getTime()) return undefined;
    const original = this.observations.get(receipt.observationId);
    if (!original) return undefined;
    const reverseObservationId = this.id();
    const reverse: ListeningObservation = {
      observationId: reverseObservationId,
      kind: "undo",
      track: original.track,
      at: now.toISOString(),
      ...(original.sessionId ? { sessionId: original.sessionId } : {}),
      reversesObservationId: original.observationId
    };
    const signalsBefore = this.signals.map(cloneSignal);
    const undoneAtBefore = receipt.undoneAt;
    this.observations.set(reverseObservationId, reverse);
    try {
    if (original.kind === "signal_correction" && original.previousSignals) {
      for (const previous of original.previousSignals) {
        const index = this.signals.findIndex((signal) => signal.signalId === previous.signalId);
        const restored = cloneSignal(previous);
        if (index >= 0) this.signals[index] = restored;
        else this.signals.push(restored);
        if (restored.scope === "long_term") {
          const newerDuplicates = this.signals.filter((signal) =>
            signal.signalId !== restored.signalId &&
            !signal.reversedAt &&
            signal.source === restored.source &&
            signal.scope === restored.scope &&
            signal.targetType === restored.targetType &&
            signal.targetKey === restored.targetKey &&
            signal.direction === restored.direction
          );
          for (const duplicate of newerDuplicates) {
            restored.observationIds = [...new Set([
              ...restored.observationIds,
              ...duplicate.observationIds
            ])].sort();
            restored.strength = Math.max(restored.strength, duplicate.strength);
            restored.updatedAt = Date.parse(duplicate.updatedAt) > Date.parse(restored.updatedAt)
              ? duplicate.updatedAt
              : restored.updatedAt;
            reverseSignal(duplicate, reverseObservationId, now);
          }
        }
      }
      receipt.undoneAt = now.toISOString();
      this.persistLearningMutation(reverse, receipt);
      return {
        ...receipt,
        changedSignals: original.previousSignals.map(cloneSignal),
        operations: Object.fromEntries(original.previousSignals.map((signal) => [
          signal.signalId,
          original.correction === "delete" || original.correction === "reset_automatic"
            ? "added"
            : "updated"
        ]))
      };
    }
    const affected: PreferenceSignal[] = [];
    for (const signal of this.signals) {
      if (!signal.observationIds.includes(original.observationId) || signal.reversedAt) continue;
      if (
        signal.source === "implicit" &&
        signal.scope === "long_term" &&
        signal.targetType === "recording"
      ) {
        affected.push(this.recomputeImplicitRecordingSignal(signal, reverseObservationId, now));
        continue;
      }
      if (signal.source === "implicit" && signal.targetType === "quota") {
        affected.push(this.recomputeQuotaSignal(signal, original, reverseObservationId, now));
        continue;
      }
      reverseSignal(signal, reverseObservationId, now);
      affected.push(signal);
    }
    receipt.undoneAt = now.toISOString();
    this.persistLearningMutation(reverse, receipt);
    return {
      ...receipt,
      changedSignals: affected.map(cloneSignal),
      operations: Object.fromEntries(affected.map((signal) => [
        signal.signalId,
        signal.reversedAt ? "removed" : "updated"
      ]))
    };
    } catch (error) {
      this.observations.delete(reverseObservationId);
      this.signals = signalsBefore;
      if (undoneAtBefore) receipt.undoneAt = undoneAtBefore;
      else delete receipt.undoneAt;
      throw error;
    }
  }

  private recomputeImplicitRecordingSignal(
    signal: PreferenceSignal,
    reverseObservationId: string,
    now: Date
  ): PreferenceSignal {
    const cutoff = now.getTime() - 30 * 24 * 60 * 60_000;
    const reversed = this.reversedObservationIds();
    const remaining = [...this.observations.values()]
      .filter((entry) => entry.kind === "playback_outcome")
      .filter((entry) => !reversed.has(entry.observationId))
      .filter((entry) => entry.track.recordingKey === signal.targetKey)
      .filter((entry) => {
        const timestamp = Date.parse(entry.at);
        return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
      })
      .map((entry) => ({ entry, classified: classifyImplicitOutcome(entry) }))
      .filter((item): item is {
        entry: ListeningObservation;
        classified: NonNullable<ReturnType<typeof classifyImplicitOutcome>>;
      } => item.classified?.direction === signal.direction);
    const sessions = new Set(remaining.flatMap(({ entry }) => entry.sessionId ? [entry.sessionId] : []));
    if (remaining.length >= 3 && sessions.size >= 2) {
      signal.observationIds = remaining.map(({ entry }) => entry.observationId).sort();
      signal.strength = Math.min(0.35, Math.max(0.18, ...remaining.map(({ classified }) => classified.strength)));
      signal.updatedAt = now.toISOString();
      delete signal.reversedAt;
      delete signal.reversedByObservationId;
      return signal;
    }
    reverseSignal(signal, reverseObservationId, now);
    return signal;
  }

  private recomputeQuotaSignal(
    signal: PreferenceSignal,
    original: ListeningObservation,
    reverseObservationId: string,
    now: Date
  ): PreferenceSignal {
    const cutoff = now.getTime() - 30 * 24 * 60 * 60_000;
    const reversed = this.reversedObservationIds();
    const valid = [...this.observations.values()]
      .filter((entry) => entry.kind === "playback_outcome" && entry.dayPeriod === original.dayPeriod)
      .filter((entry) => !reversed.has(entry.observationId))
      .filter((entry) => {
        const timestamp = Date.parse(entry.at);
        return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
      })
      .map((entry) => ({ entry, classified: classifyImplicitOutcome(entry) }))
      .filter((item): item is {
        entry: ListeningObservation;
        classified: NonNullable<ReturnType<typeof classifyImplicitOutcome>>;
      } => Boolean(item.classified));
    const positiveRate = valid.length > 0
      ? valid.filter(({ classified }) => classified.direction === "positive").length / valid.length
      : 0;
    const strongNegativeRate = valid.length > 0
      ? valid.filter(({ classified }) => classified.direction === "negative" && classified.strength >= 0.3).length / valid.length
      : 0;
    if (valid.length >= 20 && (positiveRate >= 0.7 || strongNegativeRate >= 0.4)) {
      signal.observationIds = valid.map(({ entry }) => entry.observationId).sort();
      signal.updatedAt = now.toISOString();
      delete signal.reversedAt;
      delete signal.reversedByObservationId;
      return signal;
    }
    reverseSignal(signal, reverseObservationId, now);
    return signal;
  }

  private reversedObservationIds(): Set<string> {
    return new Set(
      [...this.observations.values()]
        .filter((entry) => entry.kind === "undo" && entry.reversesObservationId)
        .map((entry) => entry.reversesObservationId!)
    );
  }

  private applyExplicitFeedback(observation: ListeningObservation): PreferenceSignal[] {
    const track = observation.track;
    const recordingKey = track.recordingKey!;
    const trackKey = getTrackKey(track);
    const scope = observation.scope ?? defaultScope(observation.reason);
    const createdAt = observation.at;
    const targets: Array<Pick<PreferenceSignal, "targetType" | "targetKey" | "direction" | "strength" | "label">> = [
      ...(observation.structuredPreferences ?? [])
    ];
    switch (observation.reason) {
      case "dislike_track":
        targets.push({ targetType: "recording", targetKey: recordingKey, direction: "negative", strength: 0.9, label: "你明确表示不喜欢这首录音" });
        break;
      case "less_this_artist":
        for (const artist of track.artists) {
          targets.push({ targetType: "artist", targetKey: artist.toLowerCase(), direction: "negative", strength: 0.65, label: `你希望少放 ${artist}` });
        }
        break;
      case "wrong_for_now":
        targets.push({ targetType: "recording", targetKey: recordingKey, direction: "negative", strength: 0.55, label: "这首歌不适合当前场景" });
        break;
      case "overplayed":
        targets.push({ targetType: "recording", targetKey: recordingKey, direction: "negative", strength: 1, label: "这首歌已进入 30 天冷却" });
        break;
      case "bad_version":
      case "playback_problem":
        targets.push({ targetType: "version", targetKey: trackKey, direction: "neutral", strength: 1, label: "这个曲源版本暂时不可用" });
        break;
      case undefined:
        break;
    }
    const expiresAt = explicitExpiry(observation, this.now());
    const changed = targets.map((target): PreferenceSignal => ({
      signalId: this.id(),
      source: "explicit",
      ...target,
      scope,
      createdAt,
      updatedAt: createdAt,
      ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      observationIds: [observation.observationId]
    }));
    this.signals.push(...changed);
    return changed;
  }

  private applySignalCorrection(observation: ListeningObservation): PreferenceSignal[] {
    const correction = observation.correction;
    if (!correction) return [];
    const targets = correction === "reset_automatic"
      ? this.signals.filter((signal) => signal.source === "implicit" && !signal.reversedAt)
      : this.signals.filter((signal) =>
          signal.signalId === observation.targetSignalId &&
          signal.source !== "manual" &&
          !signal.reversedAt
        );
    if (targets.length === 0) return [];
    observation.previousSignals = targets.map(cloneSignal);
    const changedAt = observation.at;
    for (const signal of targets) {
      const previousLabel = signal.label;
      signal.updatedAt = changedAt;
      signal.observationIds = [...new Set([...signal.observationIds, observation.observationId])];
      if (correction === "confirm") {
        signal.source = "explicit";
        signal.scope = "long_term";
        signal.strength = Math.max(0.65, signal.strength);
        delete signal.expiresAt;
        signal.label = `你已确认：${previousLabel}`;
      } else if (correction === "decrease") {
        signal.strength = Math.max(0.05, signal.strength * 0.5);
        if (signal.value !== undefined) signal.value = signal.strength;
        signal.label = `你已降低：${previousLabel}`;
      } else if (correction === "block") {
        signal.source = "explicit";
        signal.scope = "long_term";
        signal.direction = "negative";
        signal.strength = 1;
        delete signal.expiresAt;
        signal.label = `你已屏蔽：${previousLabel}`;
      } else if (correction === "delete") {
        signal.reversedAt = changedAt;
        signal.reversedByObservationId = observation.observationId;
        signal.label = `你已删除：${previousLabel}`;
      } else if (correction === "reset_automatic") {
        signal.reversedAt = changedAt;
        signal.reversedByObservationId = observation.observationId;
        signal.label = `你已重置自动信号：${previousLabel}`;
      }
    }
    return targets.map(cloneSignal);
  }

  private applyPlaybackOutcome(observation: ListeningObservation): PreferenceSignal[] {
    if (observation.outcome !== "playback_error") {
      const classified = classifyImplicitOutcome(observation);
      if (!classified) return [];
      const createdAt = observation.at;
      const recordingKey = observation.track.recordingKey!;
      const sessionSignal: PreferenceSignal = {
        signalId: this.id(),
        source: "implicit",
        targetType: "recording",
        targetKey: recordingKey,
        direction: classified.direction,
        strength: classified.strength,
        scope: "session",
        createdAt,
        updatedAt: createdAt,
        ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
        expiresAt: new Date(this.now().getTime() + 2 * 60 * 60_000).toISOString(),
        observationIds: [observation.observationId],
        label: classified.label
      };
      this.signals.push(sessionSignal);
      const changed = [sessionSignal];
      const thirtyDaysAgo = this.now().getTime() - 30 * 24 * 60 * 60_000;
      const reversed = this.reversedObservationIds();
      const consistent = [...this.observations.values()]
        .filter((entry) => entry.kind === "playback_outcome")
        .filter((entry) => !reversed.has(entry.observationId))
        .filter((entry) => entry.track.recordingKey === recordingKey)
        .filter((entry) => Date.parse(entry.at) >= thirtyDaysAgo)
        .map((entry) => ({ entry, classified: classifyImplicitOutcome(entry) }))
        .filter((item): item is { entry: ListeningObservation; classified: NonNullable<ReturnType<typeof classifyImplicitOutcome>> } =>
          item.classified?.direction === classified.direction
        );
      const sessions = new Set(consistent.flatMap(({ entry }) => entry.sessionId ? [entry.sessionId] : []));
      if (consistent.length >= 3 && sessions.size >= 2) {
        const observationIds = consistent.map(({ entry }) => entry.observationId).sort();
        const current = this.signals.find((signal) =>
          signal.source === "implicit" &&
          signal.scope === "long_term" &&
          signal.targetType === "recording" &&
          signal.targetKey === recordingKey &&
          signal.direction === classified.direction &&
          !signal.reversedAt
        );
        if (current) {
          current.updatedAt = createdAt;
          current.observationIds = observationIds;
          current.strength = Math.min(0.35, Math.max(current.strength, classified.strength));
          changed.push(current);
        } else {
          const promoted: PreferenceSignal = {
            signalId: this.id(),
            source: "implicit",
            targetType: "recording",
            targetKey: recordingKey,
            direction: classified.direction,
            strength: Math.min(0.35, Math.max(0.18, classified.strength)),
            scope: "long_term",
            createdAt,
            updatedAt: createdAt,
            observationIds,
            label: classified.direction === "positive"
              ? "多次完整收听形成长期正向偏好"
              : "多次主动早跳形成长期降权"
          };
          this.signals.push(promoted);
          changed.push(promoted);
        }
      }
      return changed;
    }
    const createdAt = observation.at;
    const signal: PreferenceSignal = {
      signalId: this.id(),
      source: "implicit",
      targetType: "version",
      targetKey: getTrackKey(observation.track),
      direction: "neutral",
      strength: 1,
      scope: "session",
      createdAt,
      updatedAt: createdAt,
      ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
      expiresAt: new Date(this.now().getTime() + 30 * 60_000).toISOString(),
      observationIds: [observation.observationId],
      label: "播放失败只冷却当前曲源版本"
    };
    this.signals.push(signal);
    return [signal];
  }

  private activeSignals(
    variants: CandidateVariant[],
    recordingKey: string,
    sessionId: string | undefined,
    at: Date
  ): PreferenceSignal[] {
    const artists = new Set(variants.flatMap(({ track }) => track.artists.map((artist) => artist.toLowerCase())));
    const trackKeys = new Set(variants.map(({ track }) => getTrackKey(track)));
    const tagKeys = new Set(variants.flatMap(({ track }) => trackTags(track).flatMap((tag) => [
      tag.value.toLowerCase(),
      `${tag.category}:${tag.value}`.toLowerCase()
    ])));
    return this.signals.filter((signal) => {
      if (signal.reversedAt) return false;
      if (signal.expiresAt && Date.parse(signal.expiresAt) <= at.getTime()) return false;
      if (signal.scope === "session" && signal.sessionId && signal.sessionId !== sessionId) return false;
      if (signal.targetType === "recording") return signal.targetKey === recordingKey;
      if (signal.targetType === "artist") return artists.has(signal.targetKey.toLowerCase());
      if (signal.targetType === "version") return trackKeys.has(signal.targetKey);
      if (signal.targetType === "tag") return tagKeys.has(signal.targetKey.toLowerCase());
      return false;
    });
  }

  private maybeAdjustQuotas(observation: ListeningObservation): PreferenceSignal[] {
    if (!observation.dayPeriod || !classifyImplicitOutcome(observation)) return [];
    const now = this.now();
    const cutoff = now.getTime() - 30 * 24 * 60 * 60_000;
    const valid = [...this.observations.values()]
      .filter((entry) => entry.kind === "playback_outcome" && entry.dayPeriod === observation.dayPeriod)
      .filter((entry) => !this.reversedObservationIds().has(entry.observationId))
      .filter((entry) => Date.parse(entry.at) >= cutoff && Date.parse(entry.at) <= now.getTime())
      .map((entry) => ({ entry, classified: classifyImplicitOutcome(entry) }))
      .filter((item): item is { entry: ListeningObservation; classified: NonNullable<ReturnType<typeof classifyImplicitOutcome>> } =>
        Boolean(item.classified)
      );
    if (valid.length < 20) return [];
    const positiveRate = valid.filter(({ classified }) => classified.direction === "positive").length / valid.length;
    const strongNegativeRate = valid.filter(({ classified }) =>
      classified.direction === "negative" && classified.strength >= 0.3
    ).length / valid.length;
    const delta = positiveRate >= 0.7 ? 1 : strongNegativeRate >= 0.4 ? -1 : 0;
    if (delta === 0) return [];
    const keys: Array<keyof DailyPlanQuotas> = observation.dayPeriod === "morning"
      ? ["morningExplore"]
      : observation.dayPeriod === "afternoon"
        ? ["afternoonSoft", "afternoonClassical"]
        : observation.dayPeriod === "evening"
          ? ["eveningMemory"]
          : [];
    const quotas = this.quotaValues();
    const changed: PreferenceSignal[] = [];
    for (const key of keys) {
      const previous = this.signals.find((signal) =>
        signal.targetType === "quota" && signal.targetKey === key && !signal.reversedAt
      );
      if (previous && now.getTime() - Date.parse(previous.updatedAt) < 7 * 24 * 60 * 60_000) continue;
      const guard = DAILY_PLAN_QUOTA_GUARDS[key];
      const next = Math.max(guard.min, Math.min(guard.max, quotas[key] + delta));
      if (next === quotas[key]) continue;
      const signal: PreferenceSignal = previous ?? {
        signalId: this.id(),
        source: "implicit",
        targetType: "quota",
        targetKey: key,
        direction: "neutral",
        strength: next,
        value: next,
        scope: "long_term",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        observationIds: [],
        label: ""
      };
      signal.strength = next;
      signal.value = next;
      signal.updatedAt = now.toISOString();
      signal.observationIds = valid.map(({ entry }) => entry.observationId).sort();
      signal.label = `${quotaLabel(key)}根据最近 ${valid.length} 次有效听播从 ${quotas[key]} 调整为 ${next}`;
      if (!previous) this.signals.push(signal);
      changed.push(signal);
    }
    return changed;
  }

  private quotaValues(): DailyPlanQuotas {
    const output: DailyPlanQuotas = { ...DEFAULT_DAILY_PLAN_QUOTAS };
    for (const key of Object.keys(output) as Array<keyof DailyPlanQuotas>) {
      const signal = this.signals
        .filter((entry) => entry.targetType === "quota" && entry.targetKey === key && !entry.reversedAt)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      const value = signal?.value ?? signal?.strength;
      if (value === undefined) continue;
      const guard = DAILY_PLAN_QUOTA_GUARDS[key];
      output[key] = Math.max(guard.min, Math.min(guard.max, Math.round(value)));
    }
    return output;
  }

  private receiptFor(
    observation: ListeningObservation,
    changedSignals: PreferenceSignal[],
    operations: Record<string, "added" | "updated" | "removed"> = {}
  ): LearningReceipt {
    const now = this.now();
    const scope = observation.scope ?? (observation.kind === "playback_outcome" ? "session" : defaultScope(observation.reason));
    return {
      receiptId: this.id(),
      observationId: observation.observationId,
      scope,
      changedSignals: changedSignals.map(cloneSignal),
      operations,
      replacedQueueCount: 0,
      summary: changedSignals[0]?.label ?? "已记录本次播放结果，未改变长期口味",
      undoToken: this.id(),
      undoExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
    };
  }
}

function collectCandidateVariants(stats: TrackStat[], candidates: RecommendationCandidate[]): CandidateVariant[] {
  const byTrackKey = new Map<string, CandidateVariant>();
  for (const stat of stats) {
    const track = normalizeTrackIdentity(stat.track);
    byTrackKey.set(getTrackKey(track), { track, stat: { ...stat, track }, source: "library", relevanceScore: 0.5 });
  }
  for (const candidate of candidates) {
    const track = normalizeTrackIdentity({ ...candidate.track, tags: candidate.tags });
    const trackKey = getTrackKey(track);
    const existing = byTrackKey.get(trackKey);
    if (!existing || candidate.relevanceScore > existing.relevanceScore) {
      byTrackKey.set(trackKey, {
        track,
        ...(existing?.stat ? { stat: existing.stat } : {}),
        source: candidate.source,
        relevanceScore: candidate.relevanceScore
      });
    }
  }
  return [...byTrackKey.values()];
}

function cloneSignal(signal: PreferenceSignal): PreferenceSignal {
  return {
    ...signal,
    observationIds: [...signal.observationIds]
  };
}

function reverseSignal(signal: PreferenceSignal, reverseObservationId: string, now: Date): void {
  signal.reversedAt = now.toISOString();
  signal.reversedByObservationId = reverseObservationId;
  signal.updatedAt = now.toISOString();
}

function signalChangeOperation(
  previous: PreferenceSignal | undefined,
  current: PreferenceSignal
): "added" | "updated" | "removed" {
  if (!previous) return "added";
  if (!previous.reversedAt && current.reversedAt) return "removed";
  if (previous.reversedAt && !current.reversedAt) return "added";
  return "updated";
}

function signalMultiplier(signals: PreferenceSignal[]): number {
  let multiplier = 1;
  for (const signal of signals) {
    if (signal.direction === "positive") multiplier *= 1 + signal.strength;
    if (signal.direction === "negative") multiplier *= Math.max(0.05, 1 - signal.strength);
  }
  return multiplier;
}

function clampMultiplier(value: number): number {
  return Math.max(0.5, Math.min(2, value));
}

function classifyImplicitOutcome(observation: ListeningObservation): {
  direction: "positive" | "negative";
  strength: number;
  label: string;
} | undefined {
  if (observation.outcome === "replay") {
    return { direction: "positive", strength: 0.3, label: "你在本次会话重播了这首歌" };
  }
  const durationMs = observation.durationMs ?? observation.track.durationMs;
  const listenedMs = observation.listenedMs ?? 0;
  const ratio = durationMs && durationMs > 0 ? listenedMs / durationMs : 0;
  if (observation.outcome === "completed" && ratio >= 0.8) {
    return { direction: "positive", strength: 0.18, label: "你完整听完了这首歌" };
  }
  if (observation.outcome === "skipped") {
    if (listenedMs <= 30_000 || ratio < 0.2) {
      return { direction: "negative", strength: 0.35, label: "你很早主动跳过了这首歌" };
    }
    return { direction: "negative", strength: 0.12, label: "你在中段主动跳过了这首歌" };
  }
  return undefined;
}

function hasVersionCooldown(signals: PreferenceSignal[], trackKey: string): boolean {
  return signals.some((signal) => signal.targetType === "version" && signal.targetKey === trackKey);
}

function hasExplicitCooldown(signals: PreferenceSignal[]): boolean {
  return signals.some((signal) =>
    signal.source === "explicit" &&
    signal.direction === "negative" &&
    signal.strength >= 1 &&
    signal.targetType !== "version"
  );
}

function defaultScope(reason: ListeningFeedbackReason | undefined): LearningScope {
  return reason === "wrong_for_now" || reason === "bad_version" || reason === "playback_problem"
    ? "session"
    : "long_term";
}

function explicitExpiry(observation: ListeningObservation, now: Date): string | undefined {
  if (observation.reason === "overplayed") return new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  if (observation.reason === "bad_version" || observation.reason === "playback_problem") {
    return new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  }
  if ((observation.scope ?? defaultScope(observation.reason)) === "session") {
    return new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
  }
  if (observation.scope === "day") {
    const end = new Date(now);
    end.setUTCHours(16, 0, 0, 0);
    if (end <= now) end.setUTCDate(end.getUTCDate() + 1);
    return end.toISOString();
  }
  return undefined;
}

function isBlocked(track: Track, rules: TasteManualRules): boolean {
  const blockedArtists = new Set(rules.blockedArtists.map((item) => item.toLowerCase()));
  if (track.artists.some((artist) => blockedArtists.has(artist.toLowerCase()))) return true;
  const blockedTags = new Set(rules.blockedTags.map((item) => item.toLowerCase()));
  return trackTags(track).some((tag) =>
    blockedTags.has(tag.value.toLowerCase()) || blockedTags.has(`${tag.category}:${tag.value}`.toLowerCase())
  );
}

function manualMultiplier(track: Track, rules: TasteManualRules): number {
  let multiplier = 1;
  for (const artist of track.artists) {
    multiplier *= rules.artistWeights[artist] ?? rules.artistWeights[artist.toLowerCase()] ?? 1;
  }
  for (const tag of trackTags(track)) {
    multiplier *= rules.tagWeights[`${tag.category}:${tag.value}`] ??
      rules.tagWeights[`${tag.category}:${tag.value.toLowerCase()}`] ??
      rules.tagWeights[tag.value] ?? 1;
  }
  return multiplier;
}

function recordingManualMultiplier(tracks: Track[], rules: TasteManualRules): number {
  const artists = [...new Set(tracks.flatMap((track) => track.artists.map((artist) => artist.toLowerCase())))];
  const tags = [...new Map(tracks.flatMap((track) => trackTags(track)).map((tag) => [
    `${tag.category}:${tag.value.toLowerCase()}`,
    tag
  ])).values()];
  let multiplier = 1;
  for (const artist of artists) {
    const configured = Object.entries(rules.artistWeights)
      .find(([key]) => key.toLowerCase() === artist)?.[1];
    multiplier *= configured ?? 1;
  }
  for (const tag of tags) {
    multiplier *= rules.tagWeights[`${tag.category}:${tag.value}`] ??
      rules.tagWeights[`${tag.category}:${tag.value.toLowerCase()}`] ??
      rules.tagWeights[tag.value] ?? 1;
  }
  return multiplier;
}

function profileAffinity(track: Track, profile: TasteProfile): number {
  const artists = new Set(track.artists.map((artist) => artist.toLowerCase()));
  const artistScore = Math.max(0, ...profile.topArtists
    .filter((artist) => artists.has(artist.name.toLowerCase()))
    .map((artist) => artist.weight));
  const keys = new Set(trackTags(track).map((tag) => `${tag.category}:${tag.value.toLowerCase()}`));
  const tagScore = profile.preferenceTags.reduce((total, tag) =>
    total + (keys.has(`${tag.category}:${tag.value.toLowerCase()}`) ? tag.weight : 0), 0);
  return clamp(artistScore + tagScore);
}

function contextAffinity(
  track: Track,
  context: ListeningRankContext | undefined,
  unfamiliar = false
): number {
  if (!context) return 0.5;
  let score = 0.4;
  const tags = trackTags(track);
  const tagKeys = new Set(tags.map((tag) => `${tag.category}:${tag.value.toLowerCase()}`));
  if (context.desiredMood) {
    const desired = normalizeMood(context.desiredMood);
    const matches = track.moodTag === desired || tags.some((tag) =>
      (tag.category === "mood" || tag.category === "scene" || tag.category === "style") &&
      normalizeMood(tag.value) === desired
    );
    score += matches ? 0.45 : -0.18;
  }
  if (context.contextTags?.length) {
    const matched = context.contextTags.filter((tag) => tagKeys.has(`${tag.category}:${tag.value.toLowerCase()}`)).length;
    score += Math.min(0.3, matched * 0.12);
  }
  if (context.weather && context.weather !== "unknown") {
    const preferred: Record<Exclude<WeatherKind, "unknown">, string[]> = {
      clear: ["energy", "warm"],
      cloudy: ["calm", "focus", "nostalgia"],
      rain: ["night", "warm", "calm"],
      snow: ["calm", "warm", "nostalgia"],
      fog: ["night", "calm", "focus"],
      storm: ["night", "energy"]
    };
    const mood = track.moodTag ?? "unknown";
    const index = preferred[context.weather].indexOf(mood);
    score += index === 0 ? 0.32 : index > 0 ? 0.24 - index * 0.04 : -0.08;
  }
  if (context.period === "late_night" && track.moodTag === "night") score += 0.22;
  if (context.period === "morning" && unfamiliar) score += 0.1;
  if (context.period === "afternoon" && isSoftTrack(track)) score += isClassicalTrack(track) ? 0.35 : 0.25;
  if (context.period === "evening" && track.moodTag === "nostalgia") score += 0.2;
  return clamp(score);
}

function trackTags(track: Track): MusicTag[] {
  const tags = [
    ...inferTrackTags(track),
    ...(track.tagEvidence ?? [])
      .filter((tag) => tag.confidence >= 0.55)
      .map(({ category, value }) => ({ category, value }))
  ];
  return [...new Map(tags.map((tag) => [`${tag.category}:${tag.value.trim().toLowerCase()}`, tag])).values()];
}

function isClassicalTrack(track: Track): boolean {
  return trackTags(track).some((tag) => tag.category === "style" && /古典|器乐|classical|instrumental|钢琴|piano/iu.test(tag.value));
}

function isSoftTrack(track: Track): boolean {
  if (isClassicalTrack(track)) return true;
  return trackTags(track).some((tag) => /calm|warm|柔和|平静|舒缓|治愈|温暖|放松|安静|acoustic|民谣|轻音乐/iu.test(tag.value));
}

function normalizeMood(value: string): string {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    安静: "calm", 平静: "calm", 柔和: "calm", 舒缓: "calm",
    专注: "focus", 工作: "focus", 温暖: "warm", 夜晚: "night",
    活力: "energy", 有劲: "energy", 怀旧: "nostalgia"
  };
  return aliases[normalized] ?? normalized;
}

function sourceQuality(source: RecommendationSource): number {
  return ({ library: 0.85, ncm_daily: 1, context_search: 0.92, style_search: 0.82, chat_search: 0.9 })[source];
}

function recommendationSourceLabel(source: RecommendationSource): string {
  return ({
    library: "来自本地曲库中的可播放版本",
    ncm_daily: "来自网易云日推候选",
    context_search: "来自当前场景搜索候选",
    style_search: "来自当前风格搜索候选",
    chat_search: "来自本次点歌搜索候选"
  })[source];
}

function currentEventSignal(
  variants: CandidateVariant[],
  events: PlayEvent[],
  at: Date
): { hidden: boolean; multiplier: number; label: string } {
  const keys = new Set(variants.map((variant) => getTrackKey(variant.track)));
  const cutoff = at.getTime() - 90 * 24 * 60 * 60_000;
  // Raw events remain useful for factual same-day playback diversity, but all
  // taste effects (skip, completion, replay and feedback) must come from
  // ListeningPolicy observations so that they can be audited and undone.
  const relevantStarts = events
    .filter((event) => keys.has(normalizeTrackReference(event.trackId)))
    .filter((event) => {
      const timestamp = Date.parse(event.at);
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= at.getTime();
    })
    .filter((event) => event.type === "play" || event.type === "play_start")
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const recentlyPlayed = relevantStarts.some((event) =>
    at.getTime() - Date.parse(event.at) <= 24 * 60 * 60_000
  );
  return recentlyPlayed
    ? { hidden: false, multiplier: 0.5, label: "刚刚播放过，先增加多样性" }
    : { hidden: false, multiplier: 1, label: "" };
}

function orderEvidence(evidence: RecommendationEvidence[]): RecommendationEvidence[] {
  const order: Record<RecommendationEvidence["type"], number> = {
    manual_rule: 0,
    explicit_preference: 1,
    implicit_behavior: 2,
    legacy_baseline: 3,
    session_intent: 4,
    context: 5,
    history: 5,
    novelty: 6,
    source_availability: 7
  };
  return [...evidence].sort((left, right) => order[left.type] - order[right.type] || right.strength - left.strength);
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function quotaLabel(key: keyof DailyPlanQuotas): string {
  return {
    morningExplore: "晨间探索配额",
    afternoonSoft: "午后柔和配额",
    afternoonClassical: "午后古典/器乐配额",
    eveningMemory: "晚间回忆配额"
  }[key];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Hard user constraints apply even when adaptive scoring is in shadow/fallback.
 * Unknown positive metadata is not evidence of a match. */
export function satisfiesListeningConstraints(track: Track, constraints: readonly ListeningConstraint[] = []): boolean {
  const normalize = (value: string) => value.trim().toLowerCase()
    .replace(/female(?: vocal)?|女歌手|女性人声/gu, "女声")
    .replace(/instrumental|纯音乐/gu, "器乐");
  const tags = inferTrackTags(track).map((tag) => normalize(tag.value));
  const searchable = normalize(`${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`);
  return constraints.filter((constraint) => constraint.hard).every((constraint) => {
    const value = normalize(constraint.value);
    if (!value) return false;
    const matches = constraint.kind === "source"
      ? (track.source ?? String(track.trackKey ?? "ncm:").split(":")[0]) === value
      : constraint.kind === "artist"
        ? track.artists.some((artist) => normalize(artist) === value)
        : tags.some((tag) => tag === value || tag.split("/").includes(value)) || searchable.includes(value);
    return constraint.kind === "avoid" ? !matches : matches;
  });
}
