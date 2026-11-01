import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

/** PW_CHROMIUM, else Playwright's own Chromium, else the one packaged by @sparticuz/chromium. */
async function chromeBinary(): Promise<string | undefined> {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // not installed
  }
  return (await import("@sparticuz/chromium")).default.executablePath();
}
const executablePath = await chromeBinary();

// The static build (dist/static) behind a plain file server, which the test starts and stops
// itself (test/static/): no dev server, nothing but files.
export default defineConfig({
  testDir: "test/static",
  outputDir: "test-results",
  timeout: 300_000,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 860 },
        actionTimeout: 30_000,
        navigationTimeout: 60_000,
        launchOptions: executablePath
          ? { executablePath, args: ["--no-sandbox", "--disable-gpu", "--no-zygote"] }
          : {},
      },
    },
  ],
});
