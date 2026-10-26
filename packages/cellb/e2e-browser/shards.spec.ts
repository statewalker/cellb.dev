import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";

// One project over several workers (startProjectShards / serveProjectShard): every counter lives
// in exactly one worker, whichever worker a request enters, so each name counts 1, 2, 3, 4.
test("a project over three workers: each cell lives in one of them", async ({ page }) => {
  const project = await bundleProjectForBrowser("counter");
  await page.goto("/shards/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  // 13 names over 3 workers: round robin sends each name through a different worker each round.
  const names = Array.from({ length: 13 }, (_, i) => `n${i}`);
  const r = await page.evaluate((job) => (window as any).__runShards(job), {
    project,
    shards: 3,
    names,
    rounds: 4,
  });
  expect(r.ok, r.error).toBe(true);
  expect(r.unsupported).toEqual([]);
  for (const name of names) expect(r.answers[name]).toEqual([1, 2, 3, 4]);
});
