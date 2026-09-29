import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "browser/e2e",
  use: { baseURL: "http://localhost:5173" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Offline fallback: a Chromium from npm (@sparticuz/chromium) when the Playwright CDN is unreachable.
        launchOptions: process.env.PW_CHROMIUM
          ? {
              executablePath: process.env.PW_CHROMIUM,
              args: ["--no-sandbox", "--disable-gpu", "--no-zygote"],
            }
          : {},
      },
    },
  ],
  webServer: {
    command: "npm run browser:prepare && npx vite browser --config browser/vite.config.ts",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
