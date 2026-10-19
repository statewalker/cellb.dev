import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

/**
 * Which Chrome runs the tests, in order:
 *   1. PW_CHROMIUM — an explicit binary;
 *   2. Playwright's own Chromium, if `npx playwright install chromium` was run;
 *   3. the headless Chromium packaged in node_modules by `@sparticuz/chromium`
 *      (unpacked to /tmp on first use) — works without access to Playwright's CDN.
 */
async function chromeBinary(): Promise<string | undefined> {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // not installed
  }
  const packaged = await import("@sparticuz/chromium");
  return packaged.default.executablePath();
}
const executablePath = await chromeBinary();

export default defineConfig({
  testDir: "browser/e2e",
  use: { baseURL: "http://localhost:5173" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath
          ? { executablePath, args: ["--no-sandbox", "--disable-gpu", "--no-zygote"] }
          : {},
      },
    },
  ],
  webServer: {
    // Plain node + vite (no package manager): also works in the mutation harness's repo copy.
    command:
      "mkdir -p browser/public/vendor && cp node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js browser/public/vendor/webrun-http-sw-worker.js && node node_modules/vite/bin/vite.js browser --config browser/vite.config.ts",
    url: "http://localhost:5173",
    // Never reuse: a stale dev server from an earlier run would serve old code.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
