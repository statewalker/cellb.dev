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

const port = Number(process.env.PORT ?? 5199);

// The host page under Vite's dev server (it serves the builder and the app's sources).
export default defineConfig({
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `node node_modules/vite/bin/vite.js browser --config browser/vite.config.ts --port ${port} --strictPort`,
    url: `http://localhost:${port}/__cellb/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  testDir: "test/browser",
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
