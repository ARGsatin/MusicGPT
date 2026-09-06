import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MusicActionPlan } from "@musicgpt/shared";

import type { AiDjAssistant } from "../src/aiDjAssistant.js";
import { fallbackClassify } from "../src/aiDjAssistant.js";
import { DailyPlanEngine } from "../src/dailyPlan.js";
import { NcmConnector } from "../src/ncmConnector.js";
import { createServer } from "../src/server.js";
import { StateRepository } from "../src/stateRepository.js";

const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe("learning API", () => {
  it("undoes the favorite side effect together with its learning signal", async () => {
    const { app, repo } = await createLearningServer();
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    const trackId = now.track?.trackKey ?? now.track?.id;
    expect(trackId).toBeDefined();

    const favorite = await app.inject({
      method: "PUT",
      url: `/api/favorites/${encodeURIComponent(String(trackId))}`,
      payload: { favorite: true }
    });
    const favoriteToken = favorite.json().learningReceipt?.undoToken as string | undefined;
    expect(repo.isTrackFavorite(trackId!)).toBe(true);
    expect(favoriteToken).toBeDefined();
    expect((await app.inject({
      method: "POST",
      url: "/api/learning/undo",
      payload: { undoToken: favoriteToken }
    })).statusCode).toBe(200);
    expect(repo.isTrackFavorite(trackId!)).toBe(false);

    const favoriteAgain = await app.inject({
      method: "PUT",
      url: `/api/favorites/${encodeURIComponent(String(trackId))}`,
      payload: { favorite: true }
    });
    expect(favoriteAgain.statusCode).toBe(200);
    const unfavorite = await app.inject({
      method: "PUT",
      url: `/api/favorites/${encodeURIComponent(String(trackId))}`,
      payload: { favorite: false }
    });
    const unfavoriteToken = unfavorite.json().learningReceipt?.undoToken as string | undefined;
    expect(repo.isTrackFavorite(trackId!)).toBe(false);
    expect(unfavoriteToken).toBeDefined();
    expect((await app.inject({
      method: "POST",
      url: "/api/learning/undo",
      payload: { undoToken: unfavoriteToken }
    })).statusCode).toBe(200);
    expect(repo.isTrackFavorite(trackId!)).toBe(true);
  });

  it("rotates the listening session and expires its intent after two idle hours", async () => {
    let clock = new Date("2026-08-25T08:00:00.000Z");
    const { app, repo } = await createLearningServer(() => new Date(clock));
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    const trackId = now.track?.trackKey ?? now.track?.id;
    expect(trackId).toBeDefined();

    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });
    const firstSession = repo.loadListeningPolicyState().observations.find((entry) =>
      entry.kind === "explicit_feedback"
    )?.sessionId;
    expect(firstSession).toBeDefined();
    repo.upsertSessionIntent({
      intentId: `session:${firstSession}`,
      value: "calm",
      scope: "session",
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
      expiresAt: new Date(clock.getTime() + 2 * 60 * 60_000).toISOString(),
      sessionId: firstSession!
    });

    clock = new Date("2026-08-25T10:00:01.000Z");
    const secondFeedback = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });
    expect(secondFeedback.statusCode).toBe(200);

    const sessions = repo.loadListeningPolicyState().observations
      .filter((entry) => entry.kind === "explicit_feedback")
      .map((entry) => entry.sessionId);
    expect(new Set(sessions).size).toBe(2);
    expect(repo.getActiveSessionIntents(clock.toISOString())).toEqual([]);
  });

  it("preserves one listening session across a service restart inside the inactivity window", async () => {
    let clock = new Date("2026-08-25T08:00:00.000Z");
    const first = await createLearningServer(() => new Date(clock));
    const current = (await first.app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    const trackId = current.track?.trackKey ?? current.track?.id;
    await first.app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });
    const firstSession = first.repo.loadListeningPolicyState().observations.find((entry) =>
      entry.kind === "explicit_feedback"
    )?.sessionId;
    expect(firstSession).toBeDefined();

    await first.app.close();
    servers.splice(servers.indexOf(first.app), 1);
    clock = new Date("2026-08-25T09:00:00.000Z");
    const secondApp = await createServer({
      repo: first.repo,
      ncm: createMockNcm(),
      now: () => new Date(clock),
      importRetryIntervalMs: 60_000
    });
    servers.push(secondApp);
    await secondApp.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });

    const sessions = first.repo.loadListeningPolicyState().observations
      .filter((entry) => entry.kind === "explicit_feedback")
      .map((entry) => entry.sessionId);
    expect(new Set(sessions)).toEqual(new Set([firstSession]));
  });

  it("extends session-scoped evidence when the listener interacts again", async () => {
    let clock = new Date("2026-08-25T08:00:00.000Z");
    const { app } = await createLearningServer(() => new Date(clock), undefined, async () => ({
      actions: [{ action: "query_current", confidence: 0.99 }],
      constraints: [],
      references: [],
      confidence: 0.99
    }));
    const current = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        type: "teach",
        trackId: current.track?.trackKey ?? current.track?.id,
        reason: "wrong_for_now",
        scope: "session"
      }
    });

    clock = new Date("2026-08-25T09:59:00.000Z");
    await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: {
        turnId: "extend-session-turn",
        commandId: "extend-session-command",
        request: "现在是什么歌",
        mode: "text_suggest"
      }
    });
    clock = new Date("2026-08-25T10:01:00.000Z");
    const taste = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: Array<{ scope: string; expiresAt?: string }> };
    };
    expect(taste.signals.explicit).toEqual([
      expect.objectContaining({ scope: "session", expiresAt: "2026-08-25T11:59:00.000Z" })
    ]);
  });

  it("does not keep a temporary intent alive merely because playback completes", async () => {
    let clock = new Date("2026-08-25T08:00:00.000Z");
    const { app, repo } = await createLearningServer(() => new Date(clock));
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      playbackId?: string;
      track?: { trackKey?: string; id: number };
    };
    const trackId = now.track?.trackKey ?? now.track?.id;
    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });
    const sessionId = repo.loadListeningPolicyState().observations.find((entry) =>
      entry.kind === "explicit_feedback"
    )?.sessionId;
    expect(sessionId).toBeDefined();
    repo.upsertSessionIntent({
      intentId: `session:${sessionId}`,
      value: "calm",
      scope: "session",
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
      expiresAt: "2026-08-25T10:00:00.000Z",
      sessionId: sessionId!
    });

    clock = new Date("2026-08-25T09:59:00.000Z");
    const outcome = await app.inject({
      method: "POST",
      url: "/api/listening/outcomes",
      payload: {
        playbackId: now.playbackId,
        trackId,
        outcome: "completed",
        listenedMs: 190_000,
        durationMs: 200_000
      }
    });
    expect(outcome.statusCode).toBe(200);
    expect(repo.getActiveSessionIntents("2026-08-25T10:00:01.000Z")).toEqual([]);
  });

  it("keeps favorite state when teaching a correction and only unfavorites explicitly", async () => {
    const { app, repo } = await createLearningServer();
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    const trackId = now.track?.trackKey ?? now.track?.id;
    expect(trackId).toBeDefined();
    repo.setTrackFavorite(trackId!, true);

    for (const [reason, scope] of [
      ["dislike_track", "long_term"],
      ["wrong_for_now", "session"],
      ["overplayed", "long_term"],
      ["less_this_artist", "long_term"],
      ["bad_version", "session"]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feedback",
        payload: { type: "teach", trackId, reason, scope }
      });
      expect(response.statusCode).toBe(200);
      expect(repo.isTrackFavorite(trackId!)).toBe(true);
    }

    const explicitUnfavorite = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "unlike", trackId }
    });
    expect(explicitUnfavorite.statusCode).toBe(200);
    expect(repo.isTrackFavorite(trackId!)).toBe(false);
  });

  it("rejects a favorite request disguised as a playback/version problem", async () => {
    const { app, repo } = await createLearningServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "like", trackId: "ncm:1", reason: "bad_version", scope: "session" }
    });

    expect(response.statusCode).toBe(400);
    expect(repo.isTrackFavorite("ncm:1")).toBe(false);
    expect(repo.loadListeningPolicyState().signals).toEqual([]);
  });

  it("learns a negative temporary intent, exposes its direction, and restores it on undo", async () => {
    const { app, repo } = await createLearningServer(undefined, undefined, async () => ({
      actions: [{ action: "update_session_intent", scope: "session", immediate: false, confidence: 0.99 }],
      constraints: [{ kind: "avoid", value: "摇滚", scope: "session", hard: true }],
      references: [],
      confidence: 0.99
    }));

    const command = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: {
        turnId: "temporary-avoid-turn",
        commandId: "temporary-avoid-command",
        request: "现在别放摇滚，后面的安静一点",
        mode: "text_suggest"
      }
    });

    expect(command.statusCode).toBe(200);
    const result = command.json() as { learningReceipt?: { undoToken: string } };
    expect(result.learningReceipt?.undoToken).toBeDefined();
    expect(repo.getActiveSessionIntents(new Date().toISOString())).toEqual([
      expect.objectContaining({ value: "摇滚", direction: "avoid" })
    ]);
    expect(repo.loadListeningPolicyState().signals).toEqual([
      expect.objectContaining({
        targetType: "tag",
        targetKey: "摇滚",
        direction: "negative",
        scope: "session"
      })
    ]);

    const undo = await app.inject({
      method: "POST",
      url: "/api/learning/undo",
      payload: { undoToken: result.learningReceipt!.undoToken }
    });
    expect(undo.statusCode).toBe(200);
    expect(repo.getActiveSessionIntents(new Date().toISOString())).toEqual([]);
    expect(repo.loadListeningPolicyState().signals.filter((signal) => !signal.reversedAt)).toEqual([]);
  });

  it("supports natural-language profile correction and undo through the shared command path", async () => {
    const plan = async (message: string): Promise<MusicActionPlan> => ({
      actions: [{ action: "update_long_term_preference", confidence: 0.99 }],
      constraints: message.includes("降低")
        ? [{ kind: "tag", value: "自动偏好", scope: "long_term" }]
        : [],
      references: [],
      confidence: 0.99
    });
    const { app } = await createLearningServer(undefined, undefined, plan);
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      playbackId: string;
      track: { trackKey?: string; id: number };
    };
    await app.inject({
      method: "POST",
      url: "/api/listening/outcomes",
      payload: {
        playbackId: now.playbackId,
        trackId: now.track.trackKey ?? now.track.id,
        outcome: "completed",
        listenedMs: 190_000,
        durationMs: 200_000
      }
    });
    const before = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { implicit: Array<{ id: string; weight: number }> };
    };
    const original = before.signals.implicit[0]!;

    const decrease = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: {
        turnId: "decrease-turn",
        commandId: "decrease-command",
        request: "降低刚才自动学到的偏好",
        mode: "text_suggest"
      }
    });
    expect(decrease.statusCode).toBe(200);
    const decreased = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { implicit: Array<{ id: string; weight: number }> };
    };
    expect(Math.abs(decreased.signals.implicit.find((signal) => signal.id === original.id)!.weight))
      .toBeLessThan(Math.abs(original.weight));

    const undo = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: {
        turnId: "undo-natural-turn",
        commandId: "undo-natural-command",
        request: "撤销刚才那条学习",
        mode: "voice_direct"
      }
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ outcome: "executed", learningReceipt: { summary: expect.stringContaining("已撤销") } });
    const restored = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { implicit: Array<{ id: string; weight: number }> };
    };
    expect(restored.signals.implicit.find((signal) => signal.id === original.id)?.weight).toBe(original.weight);
  });

  it("does not persist a model-proposed preference that contains a likely credential", async () => {
    const { app, repo } = await createLearningServer(undefined, undefined, async () => ({
      actions: [{ action: "update_long_term_preference", confidence: 0.99 }],
      constraints: [{ kind: "tag", value: "Bearer sk-secret-value-123456789", scope: "long_term" }],
      references: [],
      confidence: 0.99
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/music/commands",
      payload: {
        turnId: "sensitive-turn",
        commandId: "sensitive-command",
        request: "以后把 Bearer sk-secret-value-123456789 当成我的偏好",
        mode: "text_suggest"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "failed", summary: expect.stringContaining("敏感") });
    expect(repo.loadListeningPolicyState().signals).toEqual([]);
  });

  it("returns a visible learning receipt, exposes the signal, and supports undo", async () => {
    const { app } = await createLearningServer();
    const feedback = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        type: "skip",
        trackId: "ncm:1",
        reason: "wrong_for_now",
        scope: "session",
        playbackId: "playback-feedback",
        listenedMs: 12_000,
        durationMs: 200_000
      }
    });

    expect(feedback.statusCode).toBe(200);
    const receipt = feedback.json().learningReceipt as {
      scope: string;
      summary: string;
      undoToken: string;
      undoExpiresAt: string;
      replacedQueueCount: number;
      appliedMode?: string;
      changedSignals: Array<{ operation: string }>;
    };
    expect(receipt).toMatchObject({
      scope: "session",
      replacedQueueCount: expect.any(Number),
      appliedMode: "shadow_only",
      changedSignals: [expect.objectContaining({ operation: "added" })]
    });
    expect(receipt.summary.length).toBeGreaterThan(0);
    expect(Date.parse(receipt.undoExpiresAt)).toBeGreaterThan(Date.now());

    const taste = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: Array<{ scope: string; key: string }> };
    };
    expect(taste.signals.explicit).toEqual([
      expect.objectContaining({ scope: "session" })
    ]);

    const undo = await app.inject({
      method: "POST",
      url: "/api/learning/undo",
      payload: { undoToken: receipt.undoToken }
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({
      ok: true,
      learningReceipt: {
        undoToken: receipt.undoToken,
        changedSignals: [expect.objectContaining({ operation: "removed" })]
      }
    });
  });

  it("hides expired temporary signals from the public taste profile", async () => {
    let clock = new Date("2026-08-25T08:00:00.000Z");
    const { app } = await createLearningServer(() => new Date(clock));
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      track?: { trackKey?: string; id: number };
    };
    const trackId = now.track?.trackKey ?? now.track?.id;
    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "teach", trackId, reason: "wrong_for_now", scope: "session" }
    });
    expect(((await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: unknown[] };
    }).signals.explicit).toHaveLength(1);

    clock = new Date("2026-08-25T10:00:01.000Z");
    expect(((await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: unknown[] };
    }).signals.explicit).toEqual([]);
  });

  it("accepts a playback outcome once and does not turn playback errors into recording dislike", async () => {
    const { app, repo } = await createLearningServer();
    const payload = {
      playbackId: "playback-outcome",
      trackId: "ncm:1",
      outcome: "playback_error",
      listenedMs: 0,
      durationMs: 200_000
    };

    const first = await app.inject({ method: "POST", url: "/api/listening/outcomes", payload });
    const duplicate = await app.inject({ method: "POST", url: "/api/listening/outcomes", payload });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, duplicate: false, learningReceipt: { scope: "session" } });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect(repo.loadListeningPolicyState().signals).toEqual([
      expect.objectContaining({ targetType: "version", targetKey: "ncm:1", direction: "neutral" })
    ]);
    expect(repo.loadListeningPolicyState().signals.some((signal) => signal.targetType === "recording")).toBe(false);
  });

  it("releases a playback outcome claim when downstream learning fails so a retry can finish", async () => {
    class SwitchableDailyPlanEngine extends DailyPlanEngine {
      fail = false;

      override generate(input: Parameters<DailyPlanEngine["generate"]>[0]) {
        if (this.fail) throw new Error("daily-plan-learning-failed");
        return super.generate(input);
      }
    }
    const dailyPlanEngine = new SwitchableDailyPlanEngine();
    const { app } = await createLearningServer(undefined, dailyPlanEngine);
    const payload = {
      playbackId: "retryable-playback-outcome",
      trackId: "ncm:1",
      outcome: "completed" as const,
      listenedMs: 190_000,
      durationMs: 200_000
    };

    dailyPlanEngine.fail = true;
    const failed = await app.inject({ method: "POST", url: "/api/listening/outcomes", payload });
    expect(failed.statusCode).toBe(500);

    dailyPlanEngine.fail = false;
    const retried = await app.inject({ method: "POST", url: "/api/listening/outcomes", payload });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      ok: true,
      duplicate: false,
      learningReceipt: { scope: "session" }
    });
  });

  it("corrects an automatic profile signal through the public taste endpoint", async () => {
    const { app } = await createLearningServer();
    const now = (await app.inject({ method: "GET", url: "/api/now" })).json() as {
      playbackId?: string;
      track?: { trackKey?: string; id: number };
    };
    expect(now.playbackId).toBeDefined();
    const outcome = await app.inject({
      method: "POST",
      url: "/api/listening/outcomes",
      payload: {
        playbackId: now.playbackId,
        trackId: now.track?.trackKey ?? now.track?.id,
        outcome: "completed",
        listenedMs: 180_000,
        durationMs: 200_000
      }
    });
    expect(outcome.statusCode).toBe(200);
    const taste = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { implicit: Array<{ id: string; weight: number }> };
    };
    const signal = taste.signals.implicit[0]!;

    const correction = await app.inject({
      method: "POST",
      url: "/api/taste/signals",
      payload: { signalId: signal.id, action: "decrease" }
    });

    expect(correction.statusCode).toBe(200);
    expect(correction.json()).toMatchObject({
      ok: true,
      learningReceipt: { changedSignals: [expect.objectContaining({ signalId: signal.id })] }
    });
    const after = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { implicit: Array<{ id: string; weight: number }> };
    };
    expect(Math.abs(after.signals.implicit[0]!.weight)).toBeLessThan(Math.abs(signal.weight));
  });

  it("can delete a legacy baseline signal without rewriting historical playback facts", async () => {
    const { app, repo } = await createLearningServer();
    const taste = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: Array<{ id: string }>; legacy: Array<{ id: string }> };
    };
    const legacy = taste.signals.legacy[0]!;

    const correction = await app.inject({
      method: "POST",
      url: "/api/taste/signals",
      payload: { signalId: legacy.id, action: "delete" }
    });

    expect(correction.statusCode).toBe(200);
    expect(repo.getTrackStats(100).some((stat) => stat.playCount > 0)).toBe(true);
    const after = (await app.inject({ method: "GET", url: "/api/taste" })).json() as {
      signals: { explicit: Array<{ label: string }>; legacy: Array<{ id: string }> };
    };
    expect(after.signals.legacy.some((signal) => signal.id === legacy.id)).toBe(false);
    expect(after.signals.explicit).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining("删除旧基线") })
    ]));
  });
});

async function createLearningServer(
  now?: () => Date,
  dailyPlanEngine?: DailyPlanEngine,
  plan?: (message: string) => Promise<MusicActionPlan>
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicgpt-learning-api-"));
  const repo = new StateRepository(path.join(dir, "state.db"));
  repo.upsertTrackStats(
    Array.from({ length: 12 }, (_, index) => ({
      track: {
        id: index + 1,
        title: `Learning ${index + 1}`,
        artists: [`Artist ${index + 1}`],
        durationMs: 200_000,
        songUrl: `https://example.com/${index + 1}.mp3`
      },
      playCount: index + 1
    }))
  );
  repo.saveRecommendationDataVersion(2);
  const ncm = createMockNcm();
  const app = await createServer({
    repo,
    ncm,
    ...(plan ? { aiDjAssistant: createPlanningAssistant(plan) } : {}),
    importRetryIntervalMs: 60_000,
    ...(now ? { now } : {}),
    ...(dailyPlanEngine ? { dailyPlanEngine } : {})
  });
  servers.push(app);
  return { app, repo };
}

function createMockNcm(): NcmConnector {
  return new NcmConnector("http://mock-ncm", "cookie=abc", async (input) => {
    const url = input.toString();
    if (url.includes("/login/status") || url.includes("/user/account")) {
      return json({ data: { account: { id: 1, anonimousUser: false }, profile: { userId: 1 } }, account: { id: 1 }, profile: { userId: 1 } });
    }
    if (url.includes("/lyric")) return json({ lrc: { lyric: "" } });
    if (url.includes("/song/url")) return json({ data: [{ id: 1, url: "https://example.com/1.mp3" }] });
    return json({ code: 200, result: { songs: [] }, data: { dailySongs: [] } });
  });
}

function createPlanningAssistant(plan: (message: string) => Promise<MusicActionPlan>): AiDjAssistant {
  return {
    status: () => ({ configured: true, provider: "test", model: "test-plan" }),
    plan: (message) => plan(message),
    classify: async (message) => fallbackClassify(message),
    selectTrack: async (_description, candidates) => ({ trackId: candidates[0]?.trackKey ?? candidates[0]?.id }),
    commentTrack: async () => "点评",
    commentCurrent: async () => "点评",
    chat: async () => "聊天"
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
