import { describe, expect, it, vi } from "vitest";

import { createStreamingTextStore } from "./streamingTextStore";

describe("streaming text store", () => {
  it("publishes appended deltas without replacing the surrounding message list", () => {
    const store = createStreamingTextStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.append("你");
    store.append("好");

    expect(store.getSnapshot()).toBe("你好");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.append("呀");
    expect(store.getSnapshot()).toBe("你好呀");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears before the next stream without duplicate publishes", () => {
    const store = createStreamingTextStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.append("partial");

    store.clear();
    store.clear();

    expect(store.getSnapshot()).toBe("");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
