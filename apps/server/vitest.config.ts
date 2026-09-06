import { defineConfig } from "vitest/config";

export default defineConfig({
  // SQLite/Fastify fixtures saturate this Windows host at the default CPU count.
  test: { maxWorkers: 4 }
});
