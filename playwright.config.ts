import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/browser",
  timeout: 75_000,
  retries: 0,
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
