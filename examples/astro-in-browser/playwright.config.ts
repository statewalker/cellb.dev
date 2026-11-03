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
// STATIC=1: the static build (`pnpm build:static`, dist/static) behind a plain file server, as it
// is published; otherwise the host page under Vite's dev server (it serves the app's sources).
const base = process.env.STATIC ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;

export default defineConfig({
  use: { baseURL: base },
  webServer: {
    command: process.env.STATIC
      ? `python3 -m http.server ${port} --bind 127.0.0.1 --directory dist/static`
      : `node node_modules/vite/bin/vite.js browser --config browser/vite.config.ts --port ${port} --strictPort`,
    url: `${base}/__cellb/`,
    reuseExistingServer: true,
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
