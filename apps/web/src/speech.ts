import type { PlayerVolume } from "./volume";

export const AUTO_SPEAK_STORAGE_KEY = "musicgpt.chat-speech.auto";
export const SPEECH_DUCKING_RATIO = 0.25;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function loadAutoSpeak(storage: ReadableStorage | undefined): boolean {
  if (!storage) {
    return true;
  }
  try {
    const saved = storage.getItem(AUTO_SPEAK_STORAGE_KEY);
    return saved === null ? true : saved !== "false";
  } catch {
    return true;
  }
}

export function saveAutoSpeak(storage: WritableStorage | undefined, enabled: boolean): void {
  try {
    storage?.setItem(AUTO_SPEAK_STORAGE_KEY, String(enabled));
  } catch {
    // Speech remains usable when private browsing blocks local storage.
  }
}

export function getDuckedPlayerVolume(preference: PlayerVolume, speechActive: boolean): PlayerVolume {
  if (!speechActive || preference.muted) {
    return preference;
  }
  return {
    ...preference,
    level: preference.level * SPEECH_DUCKING_RATIO
  };
}

export interface SpeechPlaybackJob {
  key: string;
  audioUrl: string;
  kind: "chat" | "dj";
}

interface SpeechAudioOutput {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface SpeechPlaybackCallbacks {
  onActiveChange?: (active: boolean) => void;
  onPlayingKeyChange?: (key: string | undefined) => void;
  onPlaybackError?: (job: SpeechPlaybackJob, error: unknown) => void;
}

export class SpeechPlaybackController {
  private current: SpeechPlaybackJob | undefined;
  private readonly chatQueue: SpeechPlaybackJob[] = [];
  private readonly djQueue: SpeechPlaybackJob[] = [];
  private readonly seenDjKeys = new Set<string>();
  private streamingChatKey: string | undefined;
  private blockedChatStreamKey: string | undefined;
  private chatStreamFinished = false;
  private active = false;
  private disposed = false;

  private readonly onEnded = () => {
    this.current = undefined;
    this.advance();
  };

  private readonly onError = () => {
    const failed = this.current;
    this.current = undefined;
    this.chatQueue.length = 0;
    this.djQueue.length = 0;
    this.streamingChatKey = undefined;
    this.blockedChatStreamKey = undefined;
    this.chatStreamFinished = false;
    this.callbacks.onPlayingKeyChange?.(undefined);
    this.setActive(false);
    if (failed) {
      this.callbacks.onPlaybackError?.(failed, new Error("speech_playback_failed"));
    }
  };

  constructor(
    private readonly audio: SpeechAudioOutput,
    private readonly callbacks: SpeechPlaybackCallbacks = {}
  ) {
    this.audio.addEventListener("ended", this.onEnded);
    this.audio.addEventListener("error", this.onError);
  }

  isPlaying(key: string): boolean {
    return this.current?.key === key;
  }

  async playNow(job: SpeechPlaybackJob): Promise<boolean> {
    this.chatQueue.length = 0;
    this.streamingChatKey = undefined;
    this.blockedChatStreamKey = undefined;
    this.chatStreamFinished = false;
    if (this.current) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.current = undefined;
    }
    return this.start(job);
  }

  enqueueChatSegment(streamKey: string, job: SpeechPlaybackJob): void {
    if (this.disposed || this.blockedChatStreamKey === streamKey) {
      return;
    }
    if (this.streamingChatKey !== streamKey) {
      this.chatQueue.length = 0;
      this.blockedChatStreamKey = undefined;
      this.streamingChatKey = streamKey;
      this.chatStreamFinished = false;
      if (this.current) {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.current = undefined;
      }
    }
    this.chatQueue.push(job);
    if (!this.current) {
      const next = this.chatQueue.shift();
      if (next) {
        void this.start(next);
      }
    }
  }

  finishChatStream(streamKey: string): void {
    if (this.blockedChatStreamKey === streamKey) {
      this.blockedChatStreamKey = undefined;
      return;
    }
    if (this.streamingChatKey !== streamKey) {
      return;
    }
    this.chatStreamFinished = true;
    if (!this.current && this.chatQueue.length === 0) {
      this.advance();
    }
  }

  enqueueDj(job: SpeechPlaybackJob): void {
    if (
      this.disposed ||
      this.seenDjKeys.has(job.key) ||
      this.current?.key === job.key ||
      this.djQueue.some((queued) => queued.key === job.key)
    ) {
      return;
    }
    this.seenDjKeys.add(job.key);
    if (this.seenDjKeys.size > 500) {
      const oldestKey = this.seenDjKeys.values().next().value;
      if (oldestKey) {
        this.seenDjKeys.delete(oldestKey);
      }
    }
    if (this.current || this.streamingChatKey) {
      this.djQueue.push(job);
      return;
    }
    void this.start(job);
  }

  stop(clearQueue = false): void {
    if (clearQueue) {
      this.djQueue.length = 0;
    }
    this.chatQueue.length = 0;
    this.streamingChatKey = undefined;
    this.blockedChatStreamKey = undefined;
    this.chatStreamFinished = false;
    if (this.current) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.current = undefined;
    }
    this.callbacks.onPlayingKeyChange?.(undefined);
    this.setActive(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop(true);
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("error", this.onError);
  }

  private advance(): void {
    const nextChat = this.chatQueue.shift();
    if (nextChat) {
      void this.start(nextChat);
      return;
    }
    if (this.streamingChatKey && !this.chatStreamFinished) {
      this.callbacks.onPlayingKeyChange?.(undefined);
      return;
    }
    this.streamingChatKey = undefined;
    this.chatStreamFinished = false;
    const nextDj = this.djQueue.shift();
    if (nextDj) {
      void this.start(nextDj);
      return;
    }
    this.callbacks.onPlayingKeyChange?.(undefined);
    this.setActive(false);
  }

  private setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;
    this.callbacks.onActiveChange?.(active);
  }

  private async start(job: SpeechPlaybackJob): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    this.current = job;
    this.audio.src = job.audioUrl;
    this.audio.currentTime = 0;
    this.callbacks.onPlayingKeyChange?.(job.key);
    this.setActive(true);
    const chatStreamKey = this.streamingChatKey;
    try {
      await this.audio.play();
      return true;
    } catch (error) {
      this.chatQueue.length = 0;
      this.djQueue.length = 0;
      this.streamingChatKey = undefined;
      this.blockedChatStreamKey = chatStreamKey;
      this.chatStreamFinished = false;
      if (this.current?.key === job.key) {
        this.current = undefined;
        this.callbacks.onPlayingKeyChange?.(undefined);
        this.setActive(false);
      }
      this.callbacks.onPlaybackError?.(job, error);
      return false;
    }
  }
}
