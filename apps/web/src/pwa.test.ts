import { describe, expect, it } from "vitest";

import { shouldRegisterServiceWorker } from "./pwa";

describe("service worker registration policy", () => {
  it("does not register service workers while running the dev server", () => {
    expect(shouldRegisterServiceWorker("development", true)).toBe(false);
  });

  it("registers service workers in production when the browser supports them", () => {
    expect(shouldRegisterServiceWorker("production", true)).toBe(true);
  });
});
