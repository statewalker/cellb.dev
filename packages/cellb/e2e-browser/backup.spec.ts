import { expect, test } from "@playwright/test";

// P06a in a real browser: sahpool (OPFS) cells, backup images in an OPFS FilesApi,
// restore into a fresh, empty pool via sahpool importDb — which Node cannot run.
test("backup to OPFS FilesApi, restore into an empty OPFS pool, and the restored cell persists", async ({
  page,
}) => {
  await page.goto("/backup/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const result = await page.evaluate(async () => {
    const w = window as any;
    const name = `c${Date.now()}`;
    const a = w.__cellWorker("a");
    await a({ op: "init", pool: `pool-a-${name}`, backup: true });
    for (let i = 0; i < 5; i++) await a({ op: "inc", name });
    await a({ op: "backupNow" });
    w.__kill("a"); // the original pool is gone for this scenario (other pool name below)
    const listed = await w.__listBackups();

    const b = w.__cellWorker("b");
    await b({ op: "init", pool: `pool-b-${name}`, backup: true }); // empty pool, same backup store
    const restored = await b({ op: "value", name });
    const after = await b({ op: "inc", name });
    w.__kill("b");

    const c = w.__cellWorker("c");
    await c({ op: "init", pool: `pool-b-${name}`, backup: false }); // no backup: only what importDb put into OPFS
    const persisted = await c({ op: "value", name });
    return { listed, restored, after, persisted };
  });
  console.log(
    "backup files:",
    JSON.stringify(result.listed.slice(0, 4)),
    "result:",
    JSON.stringify({ ...result, listed: undefined }),
  );
  expect(result.listed.some((f: string) => /^cells\/Counter\/[0-9a-f]{64}\.sqlite$/.test(f))).toBe(
    true,
  );
  expect(result.listed.some((f: string) => f.endsWith(".sqlite.json"))).toBe(true);
  expect(result.listed.some((f: string) => f.endsWith(".tmp"))).toBe(false); // temp file moved into place
  expect(result).toMatchObject({ restored: 5, after: 6, persisted: 6 });
});
