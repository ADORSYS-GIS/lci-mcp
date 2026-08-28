import { defineConfig } from "vitest/config";

// Unit tests only. e2e/ is a separate, slower suite (spawns the real built CLI) with its own
// config (vitest.e2e.config.ts), run explicitly via `test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
