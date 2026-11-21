import { defineConfig } from "vitest/config";

// The Node suite (test/*.test.ts); the browser suite (test/browser) runs with Playwright.
// OCR takes seconds per page and a test can wait for a whole PDF job.
export default defineConfig({
  test: { include: ["test/*.test.ts"], testTimeout: 300_000, hookTimeout: 120_000 },
});
