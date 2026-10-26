import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";

// The browser entry point on its own: a counter Durable Object (the sql-counter project, bundled
// as `celld deploy` uploads it) through `@statewalker/cellb/browser` in a Dedicated Worker.
test("a counter Durable Object runs through @statewalker/cellb/browser", async ({ page }) => {
  const project = await bundleProjectForBrowser("sql-counter");
  await page.goto("/entry/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate((p) => (window as any).__runProject(p), project);
  expect(r.ok, r.error).toBe(true);
  expect(r.counts).toEqual([{ n: 1 }, { n: 2 }]);
});
