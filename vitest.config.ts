import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**", "packages/security/src/**", "packages/providers/src/**"],
      exclude: ["**/index.ts"],
      thresholds: { branches: 80, lines: 80, functions: 80, statements: 80 },
    },
  },
});
