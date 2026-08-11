export interface StreamingTextStore {
  append(delta: string): void;
  clear(): void;
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
}

export function createStreamingTextStore(): StreamingTextStore {
  let text = "";
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    append(delta) {
      if (!delta) {
        return;
      }
      text += delta;
      publish();
    },
    clear() {
      if (!text) {
        return;
      }
      text = "";
      publish();
    },
    getSnapshot() {
      return text;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
