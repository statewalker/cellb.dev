import { expect, test } from "@playwright/test";

// SQLite (sync, in a worker) over a cell's LTX files on OPFS, read and written asynchronously
// by the page; a fresh worker per round (no state carried in memory); streamed compaction.
test("sync SQLite over async LTX files: write, read back cold, compact", async ({ page }) => {
  test.setTimeout(300_000);
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  await page.goto("/__cellb/ltx-lab.html");
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 60_000,
  });
  const run = (script: string, cachePages?: number) =>
    page.evaluate(([s, c]) => (window as any).__run(s, c), [
      script,
      cachePages,
    ] as const) as Promise<any>;
  const log = (what: string, r: any) =>
    console.log(
      `${what}: ${r.ok ? JSON.stringify(r.out) : r.error} · ${r.ms} ms · files ${r.files} · reads ${r.stats?.reads} (cache ${r.stats?.cacheHits}, store ${r.stats?.storeReads}), commits ${r.stats?.commits}, blocked ${r.stats?.blockedMs} ms`,
    );

  const w = await run(`
    db.exec("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, title TEXT, body BLOB)");
    for (let t = 0; t < 20; t++) {
      db.exec("BEGIN");
      for (let i = 0; i < 100; i++) db.exec({ sql: "INSERT INTO docs (title, body) VALUES (?, randomblob(2000))", bind: ["doc " + (t * 100 + i)] });
      db.exec("COMMIT");
    }
    return db.selectValue("SELECT count(*) FROM docs");`);
  log("write 20 transactions × 100 rows (2 KB each)", w);
  expect(w.out).toBe(2000);
  expect(w.files).toBe(21); // the snapshot (schema) + one LTX file per transaction

  const one = await run(`return db.selectValue("SELECT title FROM docs WHERE id = 1234")`);
  log("cold worker, one row by key", one);
  expect(one.out).toBe("doc 1233");

  const all = await run(
    `return db.selectValue("SELECT count(*) || ':' || sum(length(body)) FROM docs")`,
  );
  log("cold worker, full scan", all);
  expect(all.out).toBe("2000:4000000");

  const c = await page.evaluate(() => (window as any).__compact());
  console.log(`compacted to ${c.files} file(s)`);
  expect(c.files).toBe(1);

  const after = await run(
    `db.exec("INSERT INTO docs (title, body) VALUES ('after', zeroblob(10))"); return db.selectValue("SELECT count(*) FROM docs")`,
  );
  log("after compaction, one more transaction", after);
  expect(after.out).toBe(2001);
  expect(after.files).toBe(2);

  const small = await run(`return db.selectValue("SELECT count(*) FROM docs")`, 32);
  log("cold worker, 32-page cache, count", small);
  expect(small.out).toBe(2001);
});
