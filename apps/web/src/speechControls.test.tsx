import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("speech controls", () => {
  it("renders auto speech on by default with one shared speech output", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("自动朗读");
    expect(html).toContain("小晓女声");
    expect(html).toContain('class="speech-audio"');
    expect(html).not.toContain('class="dj-audio"');
  });
});
