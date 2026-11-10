import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(here, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // tests share one local database
    testTimeout: 30000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/intheanswer_test",
      APP_SECRET: "test-secret",
      APP_URL: "https://intheanswer.test",
      DRY_RUN: "1",
      EXTERNAL_MODE: "replay",
    },
    globalSetup: ["tests/globalSetup.ts"],
  },
});
