import { describe, expect, it } from "vitest";

import { withAiProviderCompatibility } from "../src/aiProviderCompatibility.js";

describe("AI provider compatibility", () => {
  it("disables thinking only for DeepSeek requests", () => {
    const request = { model: "test-model", messages: [] };

    expect(withAiProviderCompatibility("deepseek", request)).toEqual({
      ...request,
      thinking: { type: "disabled" }
    });
    expect(withAiProviderCompatibility("openai", request)).toBe(request);
  });
});

