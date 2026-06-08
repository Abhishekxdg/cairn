import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Barrel re-exports and pure type modules carry no testable logic.
      exclude: ["src/index.ts", "src/core/types.ts"],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90,
        branches: 75,
      },
    },
  },
});
