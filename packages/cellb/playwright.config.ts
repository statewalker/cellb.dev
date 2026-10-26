import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";
import { freePort } from "./test/free-port.ts";
import { setupTestBucket } from "./test/test-bucket.ts";

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

// Set up at config load, not in a globalSetup: Playwright starts the webServer before
// globalSetup, and Vite needs the port and RUSTFS_ENDPOINT. Worker processes load this config
// again and inherit the values through the environment, so they reuse them.
process.env.PW_PORT ??= String(await freePort());
const port = Number(process.env.PW_PORT);
await setupTestBucket(); // stops its RustFS (if it started one) when this process exits

export default defineConfig({
  testDir: "e2e-browser",
  // e2e-browser/probes holds the exploratory probes (playwright.probes.config.ts).
  testIgnore: /\.probe\.spec\.ts$/,
  use: { baseURL: `http://localhost:${port}` },
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
    command: `mkdir -p e2e-browser/pages/public/vendor && cp node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js e2e-browser/pages/public/vendor/webrun-http-sw-worker.js && node node_modules/vite/bin/vite.js e2e-browser/pages --config e2e-browser/pages/vite.config.ts --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    // Never reuse: a stale dev server from an earlier run would serve old code.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
