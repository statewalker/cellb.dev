// Start times of one-run containers in Chromium (opt-in): WORKER_POOL_PROBE=1 pnpm e2e isolated-start
import { expect, test } from "@playwright/test";

const enabled = !!process.env.WORKER_POOL_PROBE;
for (const runtime of ["quickjs", "python", "edgejs"]) {
  test(`one-run containers, start times: ${runtime}`, async ({ page }) => {
    test.skip(!enabled, "set WORKER_POOL_PROBE=1");
    test.setTimeout(300_000);
    await page.goto("/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const r = await page.evaluate((name) => (window as any).__isolatedStart(name), runtime);
    console.log(
      `${runtime}: 2 cold in ${r.cold} ms; run with a ready container ${r.readyMs} ms; refill ${r.refillMs} ms (medians of 8)`,
    );
    expect(r.readyMs).toBeGreaterThan(0);
  });
}
