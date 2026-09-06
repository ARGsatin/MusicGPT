import type {
  DailyPlan,
  MusicSourceStatus,
  NowPlayingState,
  SystemStatus,
  TasteResponse
} from "@musicgpt/shared";

export const FULL_STATE_RESTORED_EVENT = "musicgpt:full-state-restored";

export interface FullStateRestoredDetail {
  dailyPlan?: DailyPlan | null;
  musicSources?: MusicSourceStatus[];
  systemStatus?: SystemStatus;
}

export interface FullStateRestoreResults {
  now: PromiseSettledResult<NowPlayingState>;
  taste: PromiseSettledResult<TasteResponse | null>;
  systemStatus: PromiseSettledResult<SystemStatus>;
  musicSources: PromiseSettledResult<MusicSourceStatus[]>;
  dailyPlan: PromiseSettledResult<DailyPlan | null>;
}

export interface FulfilledRestoreState {
  now?: NowPlayingState;
  taste?: TasteResponse | null;
  systemStatus?: SystemStatus;
  detail: FullStateRestoredDetail;
}

export function selectFulfilledRestoreState(results: FullStateRestoreResults): FulfilledRestoreState {
  return {
    ...(results.now.status === "fulfilled" ? { now: results.now.value } : {}),
    ...(results.taste.status === "fulfilled" ? { taste: results.taste.value } : {}),
    ...(results.systemStatus.status === "fulfilled" ? { systemStatus: results.systemStatus.value } : {}),
    detail: {
      ...(results.dailyPlan.status === "fulfilled" ? { dailyPlan: results.dailyPlan.value } : {}),
      ...(results.musicSources.status === "fulfilled" ? { musicSources: results.musicSources.value } : {}),
      ...(results.systemStatus.status === "fulfilled" ? { systemStatus: results.systemStatus.value } : {})
    }
  };
}

export function announceFullStateRestore(detail: FullStateRestoredDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<FullStateRestoredDetail>(FULL_STATE_RESTORED_EVENT, { detail }));
}
