import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("speech controls", () => {
  it("renders auto speech on by default with one shared speech output", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("自动朗读");
    expect(html).toContain("全程小晓声线");
    expect(html).not.toContain("Sonia");
    expect(html).toContain('class="speech-audio"');
    expect(html).not.toContain('class="dj-audio"');
  });
});
