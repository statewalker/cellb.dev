import { defineConfig, devices } from "@playwright/test";

// Chromium: PW_CHROMIUM if set, else Playwright's own. Wasmer packages come from its registry,
// so the browser uses the environment's HTTPS proxy when there is one.
const port = Number(process.env.PW_PORT ?? 5199);
const notebookPort = Number(process.env.PW_NOTEBOOK_PORT ?? 5198);
const proxy = process.env.HTTPS_PROXY
  ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }
  : undefined;

export default defineConfig({
  testDir: "e2e-browser",
  timeout: 180_000,
  globalSetup: "./e2e-browser/global-setup.ts",
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined, proxy },
      },
    },
  ],
  webServer: [
    {
      command: `vite --config e2e-browser/vite.config.ts --port ${port} --strictPort`,
      url: `http://localhost:${port}/`,
      reuseExistingServer: false,
    },
    {
      // the interactive notebook example (e2e-browser/notebook.spec.ts)
      command: `vite --config examples/observable-framework/notebook/vite.config.ts --port ${notebookPort} --strictPort`,
      url: `http://localhost:${notebookPort}/`,
      reuseExistingServer: !!process.env.PW_REUSE_NOTEBOOK,
    },
  ],
});
