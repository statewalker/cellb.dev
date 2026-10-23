import { expect, test } from "@playwright/test";

// LTX in Chromium: SQLite WASM on OPFS with the page hook; each commit becomes an LTX file of
// only the changed pages; a worker with an EMPTY pool restores the cell from those files.
test("LTX log on OPFS: changed pages only, restore into an empty pool", async ({ page }) => {
  await page.goto("/ltx/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const run = Date.now().toString(36);
  const first = await page.evaluate(
    (run) =>
      (window as any).__log({
        pool: `a-${run}`,
        logDir: `ltx-${run}`,
        op: "add",
        texts: ["alpha", "beta", "gamma"],
      }),
    run,
  );
  expect(first.ok, first.error).toBe(true);
  const [snapshot, ...incremental] = first.ltx;
  expect(snapshot.pages).toBe(snapshot.commit); // the generation starts with every page
  expect(incremental.length, JSON.stringify(first.ltx)).toBeGreaterThanOrEqual(2);
  for (const f of incremental)
    expect(f.pages, JSON.stringify(first.ltx)).toBeLessThan(f.commit / 4); // the hook: few pages per commit
  const second = await page.evaluate(
    (run) => (window as any).__log({ pool: `b-${run}`, logDir: `ltx-${run}`, op: "dump" }),
    run,
  );
  expect(second.ok, second.error).toBe(true);
  expect(second.dump).toEqual(first.dump);
});
