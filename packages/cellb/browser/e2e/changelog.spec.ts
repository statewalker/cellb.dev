import { expect, test } from "@playwright/test";

// P10 in Chromium: transaction-log segments (SQLite changesets, ROWID tables included) on
// OPFS; a worker with an empty SQLite pool rebuilds the cell from the log alone.
test("cells are rebuilt from the OPFS transaction log in a worker with an empty database", async ({
  page,
}) => {
  await page.goto("/changelog/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const run = Date.now().toString(36);
  const first = await page.evaluate(
    (run) =>
      (window as any).__log({
        pool: `a-${run}`,
        logDir: `log-${run}`,
        op: "add",
        texts: ["alpha", "beta", "gamma"],
      }),
    run,
  );
  expect(first.ok, first.error).toBe(true);
  expect(first.segments).toBeGreaterThanOrEqual(3);
  const second = await page.evaluate(
    (run) => (window as any).__log({ pool: `b-${run}`, logDir: `log-${run}`, op: "dump" }),
    run,
  );
  expect(second.ok, second.error).toBe(true);
  expect(second.dump).toEqual(first.dump);
  expect(second.dump.notes.map((n: any) => n.text)).toEqual(["alpha", "beta", "gamma"]);
  expect(second.dump.tags).toEqual([{ tag: "a" }, { tag: "b" }, { tag: "g" }]);
});
