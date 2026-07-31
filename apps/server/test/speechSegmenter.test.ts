import { describe, expect, it } from "vitest";

import { SpeechTextSegmenter } from "../src/speechSegmenter.js";

describe("SpeechTextSegmenter", () => {
  it("releases a natural sentence as soon as streamed text reaches punctuation", () => {
    const segmenter = new SpeechTextSegmenter();

    expect(segmenter.push("好呀，")).toEqual([]);
    expect(segmenter.push("今天来听点轻快的。下一句还在生成")).toEqual([
      "好呀，今天来听点轻快的。"
    ]);
    expect(segmenter.finish()).toEqual(["下一句还在生成"]);
  });

  it("bounds latency when the model produces a long sentence without punctuation", () => {
    const segmenter = new SpeechTextSegmenter({ maxChars: 18 });

    const ready = segmenter.push("这是一段一直没有任何标点但仍然需要尽快开始朗读的长回复");

    expect(ready).toHaveLength(1);
    expect([...ready[0]!]).toHaveLength(18);
    expect(segmenter.finish().join("")).toBe("快开始朗读的长回复");
  });

  it("uses English sentence punctuation as a natural speech boundary", () => {
    const segmenter = new SpeechTextSegmenter();

    expect(segmenter.push("That makes sense. Let me think about the next part")).toEqual([
      "That makes sense."
    ]);
    expect(segmenter.finish()).toEqual(["Let me think about the next part"]);
  });
});
