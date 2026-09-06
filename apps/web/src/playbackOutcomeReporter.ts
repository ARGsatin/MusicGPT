import type { LearningReceipt, PlaybackOutcomeRequest } from "@musicgpt/shared";

export interface PlaybackOutcomeResponse {
  duplicate: boolean;
  learningReceipt?: LearningReceipt;
}

export interface PlaybackOutcomeReporterOptions {
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export function createPlaybackOutcomeReporter(
  send: (request: PlaybackOutcomeRequest) => Promise<PlaybackOutcomeResponse>,
  options: PlaybackOutcomeReporterOptions = {}
) {
  const reports = new Map<string, Promise<PlaybackOutcomeResponse>>();
  const retryDelaysMs = options.retryDelaysMs ?? [250, 750];
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  }));

  const sendWithRetry = async (request: PlaybackOutcomeRequest): Promise<PlaybackOutcomeResponse> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      try {
        return await send(request);
      } catch (error) {
        lastError = error;
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) break;
        await wait(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Playback outcome could not be saved");
  };

  return {
    report(request: PlaybackOutcomeRequest): Promise<PlaybackOutcomeResponse> {
      const existing = reports.get(request.playbackId);
      if (existing) return existing;
      const pending = sendWithRetry(request).catch((error) => {
        reports.delete(request.playbackId);
        throw error;
      });
      reports.set(request.playbackId, pending);
      return pending;
    },
    reportBeacon(
      request: PlaybackOutcomeRequest,
      sendBeacon: (request: PlaybackOutcomeRequest) => boolean
    ): boolean {
      if (reports.has(request.playbackId)) return true;
      if (!sendBeacon(request)) return false;
      reports.set(request.playbackId, Promise.resolve({ duplicate: false }));
      return true;
    }
  };
}
