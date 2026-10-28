import { existsSync } from "node:fs";
import { createServer } from "node:net";
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
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const executablePath = await chromeBinary();
// Worker processes load this config again: they reuse the port through the environment.
process.env.PW_PORT ??= String(await freePort());
const port = Number(process.env.PW_PORT);

export default defineConfig({
  testDir: "test/browser",
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
    command: `node node_modules/vite/bin/vite.js browser --config browser/vite.config.ts --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
