import { test } from "@playwright/test";

// Hypothesis check: which minimal ServiceWorkers control a page after a reload?
for (const kind of ["none", "fall", "respond"])
  test(`reload under a SW with fetch handler: ${kind}`, async ({ page, browserName }) => {
    await page.goto(`/swprobe/${kind}/index.html`);
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    console.log(
      browserName,
      kind,
      "controlled after reload:",
      await page.evaluate(() => !!navigator.serviceWorker.controller),
    );
  });
