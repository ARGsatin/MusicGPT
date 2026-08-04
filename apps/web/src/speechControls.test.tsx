import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("speech controls", () => {
  it("renders one shared Qwen3.5 Omni Realtime voice output without Edge TTS", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("文字自动播报");
    expect(html).toContain("开启实时语音");
    expect(html).toContain("Qwen Realtime · Tina");
    expect(html).not.toContain("小晓");
    expect(html).not.toContain("Edge");
    expect(html).not.toContain("tts-cache");
    expect(html).toContain('class="speech-audio"');
    expect(html).not.toContain('class="dj-audio"');
  });
});
