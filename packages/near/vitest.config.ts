import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Reads chain state the agent and check page trust: every line and refusal branch must run.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
