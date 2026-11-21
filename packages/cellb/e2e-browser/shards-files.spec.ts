import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";

// Shards whose cells live on the page's own FilesApi (statewalker/cellb.dev#185):
// startProjectShards({ bucket: (shard) => ({ ltx, node, files: { port } }) }) gives each shard's
// LTX store a port of its own (filesApiPort), transferred with that shard's init. The cells
// then move with the FilesApi: a different number of shards opens them where the first left off.
test("shards keep their cells on the page's FilesApi, one port per shard", async ({ page }) => {
  const project = await bundleProjectForBrowser("counter");
  await page.goto("/labs/shards-files.html");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const names = Array.from({ length: 7 }, (_, i) => `n${i}`);
  const run = (shards: number, rounds: number, label: string) =>
    page.evaluate((job) => (window as any).__run(job), { project, shards, names, rounds, label });

  const first = await run(2, 3, "a");
  expect(first.ok, first.error).toBe(true);
  for (const name of names) expect(first.answers[name]).toEqual([1, 2, 3]);
  expect(await page.evaluate(() => (window as any).__ltxFiles())).toBeGreaterThan(0);

  // Three other shards, other workers: the counters continue from the page's FilesApi.
  const second = await run(3, 2, "b");
  expect(second.ok, second.error).toBe(true);
  for (const name of names) expect(second.answers[name]).toEqual([4, 5]);
});
