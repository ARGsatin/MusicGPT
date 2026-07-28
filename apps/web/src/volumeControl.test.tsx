import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("volume controls", () => {
  it("renders an accessible volume slider and mute button", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Playback volume"');
    expect(html).toContain('aria-label="Mute"');
  });
});
