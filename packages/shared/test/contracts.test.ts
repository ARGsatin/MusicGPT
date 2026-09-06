import { describe, expect, it } from "vitest";

import {
  API_ROUTES,
  encodeWsPayload,
  isChatRequest,
  isDjSettingsRequest,
  isEnvironmentLocationRequest,
  isFavoriteRequest,
  isFeedbackRequest,
  isLearningUndoRequest,
  isTasteSignalMutationRequest,
  isNextRequest,
  isPlaybackOutcomeRequest,
  isPlayTrackRequest
} from "../src/contracts.js";

describe("contracts", () => {
  it("validates chat payload", () => {
    expect(isChatRequest({ message: "换点轻松的" })).toBe(true);
    expect(isChatRequest({ message: "" })).toBe(false);
  });

  it("validates feedback payload", () => {
    expect(isFeedbackRequest({ type: "like", trackId: 1 })).toBe(true);
    expect(
      isFeedbackRequest({
        type: "teach",
        trackId: "ncm:1",
        reason: "wrong_for_now",
        scope: "session"
      })
    ).toBe(true);
    expect(
      isFeedbackRequest({
        type: "skip",
        trackId: "qq:003abc",
        reason: "wrong_for_now",
        scope: "session",
        playbackId: "playback-1",
        decisionId: "decision-1",
        listenedMs: 12_000,
        durationMs: 240_000
      })
    ).toBe(true);
    expect(isFeedbackRequest({ type: "oops", trackId: 1 })).toBe(false);
    expect(isFeedbackRequest({ type: "skip", trackId: 1, reason: "not-a-reason" })).toBe(false);
    expect(isFeedbackRequest({ type: "skip", trackId: 1, scope: "forever" })).toBe(false);
    expect(isFeedbackRequest({ type: "skip", trackId: 1, listenedMs: -1 })).toBe(false);
  });

  it("validates idempotent playback outcomes and learning undo", () => {
    expect(
      isPlaybackOutcomeRequest({
        playbackId: "playback-1",
        trackId: "ncm:42",
        outcome: "completed",
        listenedMs: 200_000,
        durationMs: 220_000,
        decisionId: "decision-1"
      })
    ).toBe(true);
    expect(
      isPlaybackOutcomeRequest({
        playbackId: "playback-1",
        trackId: "qq:003abc",
        outcome: "playback_error",
        listenedMs: 0
      })
    ).toBe(true);
    expect(isPlaybackOutcomeRequest({ playbackId: "", trackId: 1, outcome: "skipped", listenedMs: 0 })).toBe(
      false
    );
    expect(isPlaybackOutcomeRequest({ playbackId: "p", trackId: 1, outcome: "liked", listenedMs: 0 })).toBe(
      false
    );
    expect(isLearningUndoRequest({ undoToken: "undo-token" })).toBe(true);
    expect(isLearningUndoRequest({ undoToken: "" })).toBe(false);
    expect(isTasteSignalMutationRequest({ signalId: "signal-1", action: "decrease" })).toBe(true);
    expect(isTasteSignalMutationRequest({ action: "reset_automatic" })).toBe(true);
    expect(isTasteSignalMutationRequest({ action: "delete" })).toBe(false);
  });

  it("validates next payload", () => {
    expect(isNextRequest({ forceReplan: true })).toBe(true);
    expect(isNextRequest({ forceReplan: "yes" })).toBe(false);
  });

  it("validates suggested track playback payload", () => {
    expect(
      isPlayTrackRequest({
        track: { id: 99, title: "Night Drive", artists: ["Ari"] },
        reason: "matches the requested mood"
      })
    ).toBe(true);
    expect(isPlayTrackRequest({ track: { id: "99", title: "Night Drive", artists: ["Ari"] } })).toBe(true);
  });

  it("encodes ws payload", () => {
    expect(encodeWsPayload({ event: "queue_updated", data: { n: 1 } })).toBe(
      "{\"event\":\"queue_updated\",\"data\":{\"n\":1}}"
    );
  });

  it("exposes V1.5 route contracts", () => {
    expect(API_ROUTES.environment).toBe("/api/environment");
    expect(API_ROUTES.environmentLocation).toBe("/api/environment/location");
    expect(API_ROUTES.importRecommendations).toBe("/api/recommendations/import");
    expect(API_ROUTES.djSettings).toBe("/api/dj/settings");
  });

  it("builds the chat speech route for a persisted assistant message", () => {
    expect(API_ROUTES.chatStream).toBe("/api/chat/stream");
    expect(API_ROUTES.realtimeSession).toBe("/api/realtime/session");
  });

  it("exposes unified conversation and idempotent music routes", () => {
    expect(API_ROUTES.realtimeContext).toBe("/api/realtime/context");
    expect(API_ROUTES.realtimeErrors).toBe("/api/realtime/errors");
    expect(API_ROUTES.voiceTurns).toBe("/api/conversation/voice/turns");
    expect(API_ROUTES.voiceTurnComplete("voice/a")).toBe(
      "/api/conversation/voice/turns/voice%2Fa/complete"
    );
    expect(API_ROUTES.musicCommands).toBe("/api/music/commands");
    expect(API_ROUTES.listeningOutcomes).toBe("/api/listening/outcomes");
    expect(API_ROUTES.learningUndo).toBe("/api/learning/undo");
    expect(API_ROUTES.tasteSignals).toBe("/api/taste/signals");
  });

  it("validates favorite payload and builds its route", () => {
    expect(isFavoriteRequest({ favorite: true })).toBe(true);
    expect(isFavoriteRequest({ favorite: "yes" })).toBe(false);
    expect(API_ROUTES.favorite(42)).toBe("/api/favorites/42");
  });

  it("exposes persistent chat memory routes", () => {
    expect(API_ROUTES.chatMemories).toBe("/api/chat/memories");
    expect(API_ROUTES.chatMemory(7)).toBe("/api/chat/memories/7");
  });

  it("exposes one-click playback for the current daily-plan segment", () => {
    expect(API_ROUTES.playDailyPlan).toBe("/api/daily-plan/play");
  });

  it("validates environment location payload", () => {
    expect(isEnvironmentLocationRequest({ latitude: 31.23, longitude: 121.47 })).toBe(true);
    expect(isEnvironmentLocationRequest({ latitude: 120, longitude: 121.47 })).toBe(false);
    expect(isEnvironmentLocationRequest({ latitude: 31.23, longitude: "121.47" })).toBe(false);
  });

  it("validates DJ settings payload", () => {
    expect(
      isDjSettingsRequest({
        tone: "lively",
        voiceGender: "female",
        voice: "marin"
      })
    ).toBe(true);
    expect(isDjSettingsRequest({ tone: "sleepy", voiceGender: "female", voice: "marin" })).toBe(false);
  });
});
