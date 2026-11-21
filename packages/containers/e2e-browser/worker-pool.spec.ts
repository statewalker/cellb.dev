// Experiment (opt-in): single-use workers in Chromium. Does terminating a worker give its memory
// back at once? WORKER_POOL_PROBE=1 pnpm e2e worker-pool
import { expect, test } from "@playwright/test";
import { availableMb, chromiumPss } from "../bench/proc.ts";

const enabled = !!process.env.WORKER_POOL_PROBE && process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("single-use Wasmer workers: warm, run, terminate, refill", async ({ page }) => {
  test.skip(!enabled, "set WORKER_POOL_PROBE=1 (Linux)");
  test.setTimeout(900_000);
  const size = Number(process.env.WP_SIZE ?? 4);
  const runs = Number(process.env.WP_RUNS ?? 20);
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const sample = (label: string) => {
    const m = chromiumPss();
    console.log(
      `${label.padEnd(30)} renderer=${m.rendererMb}MB threads=${m.rendererThreads} all=${m.allMb}MB available=${availableMb()}MB`,
    );
    return m;
  };
  sample("baseline");
  const warmMs = await page.evaluate((n) => (window as any).__wpWarm(n), size);
  console.log(`warmed ${size} in parallel: ${warmMs.join(", ")} ms`);
  const warmed = sample(`${size} warm workers`);
  const refills: number[] = [];
  let afterRun = warmed;
  for (let i = 0; i < runs; i++) {
    const r = await page.evaluate((k) => (window as any).__wpRunOnce(k), i);
    expect(r.exitCode).toBe(0);
    const at0 = sample(`run ${i}: ${r.runMs} ms, terminate ${r.terminateMs} ms`);
    await sleep(100);
    const at100 = sample("  +100 ms");
    await sleep(900);
    afterRun = sample("  +1 s");
    if (i < 3)
      console.log(
        `  freed at once: ${warmed.rendererMb - at0.rendererMb} MB, after 100 ms: ${warmed.rendererMb - at100.rendererMb} MB`,
      );
    refills.push(await page.evaluate(() => (window as any).__wpRefill()));
  }
  console.log(`refill ms: ${refills.join(", ")}`);
  await page.evaluate(() => (window as any).__wpTerminateAll());
  await sleep(2000);
  sample("all terminated, +2 s");
  void afterRun;
});
