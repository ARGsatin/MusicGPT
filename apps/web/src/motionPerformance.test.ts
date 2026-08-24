import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("ambient motion performance budget", () => {
  it("allows only the compositor-safe turntable and status ticker to run infinitely", () => {
    const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const infiniteAnimations = styles.match(/animation\s*:[^;{}]*\binfinite\b/g) ?? [];

    expect(infiniteAnimations).toEqual([
      "animation: vinyl-spin 24s linear infinite",
      "animation: ticker-scroll 42s linear infinite"
    ]);
    expect(styles).toMatch(
      /\.vinyl\.is-spinning\s*\{[^}]*animation:\s*vinyl-spin 24s linear infinite;[^}]*will-change:\s*transform;/s,
    );
    expect(styles).toMatch(
      /\.ticker-track\s*\{[^}]*display:\s*flex;[^}]*animation:\s*ticker-scroll 42s linear infinite;[^}]*will-change:\s*transform;/s,
    );
    expect(styles).toMatch(
      /@keyframes ticker-scroll\s*\{[^}]*transform:\s*translate3d\(-50%,\s*0,\s*0\);[^}]*\}/s,
    );
  });

  it("uses a static status rail when reduced motion is requested", () => {
    const styles = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.ticker-track\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.ticker-static\s*\{[^}]*display:\s*flex;/,
    );
  });
});
