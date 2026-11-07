import { expect, test } from "@playwright/test";

// The app's own FilesApi (in memory on the page), opened before cellb's workers start: cells on
// the LTX VFS write their LTX files into it, and a later shard worker reads them back, with
// the store in a worker of its own (the FilesApi over a port) or on the page.
for (const store of ["worker", "page"] as const)
  test(`LTX cells on the app's FilesApi (store on the ${store})`, async ({ page }) => {
    await page.goto(`/labs/ltx-files.html?store=${store}`);
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const first = await page.evaluate(() =>
      (window as any).__shard([
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)",
        "WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 500) INSERT INTO notes (text) SELECT 'note ' || v FROM n",
        "SELECT count(*) FROM notes",
      ]),
    );
    expect(first.ok, first.error).toBe(true);
    expect(first.results[2]).toEqual([[500]]);
    const files: string[] = await page.evaluate(() => (window as any).__files());
    expect(files.length, JSON.stringify(files)).toBeGreaterThanOrEqual(2);
    for (const f of files)
      expect(f).toMatch(/^\/cells\/Notes:0001\/ltx\/e1\/0000\/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$/);
    // A new shard worker (a new store): the cell from the page's FilesApi alone.
    const second = await page.evaluate(() =>
      (window as any).__shard([
        "INSERT INTO notes (text) VALUES ('later')",
        "SELECT count(*), max(text) FROM notes",
      ]),
    );
    expect(second.ok, second.error).toBe(true);
    expect(second.results[1]).toEqual([[501, "note 99"]]);
  });
