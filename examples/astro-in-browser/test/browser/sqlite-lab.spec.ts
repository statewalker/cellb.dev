import { test } from "@playwright/test";

// N workers at once, each with its own SQLite database, in each storage mode; then the same
// workers again (restore: the rows of the first round must be there).
test("SQLite in parallel workers: storage modes", async ({ page }) => {
  test.setTimeout(600_000);
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  await page.goto("/__cellb/sqlite-lab.html");
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 60_000,
  });
  const N = Number(process.env.LAB_N ?? 16);
  const K = 200;
  const rows: string[] = [];
  for (const mode of [
    "sahpool-own",
    "sahpool-shared",
    "opfs",
    "opfs-same",
    "memdb-pages",
    "memdb-pages-idb",
  ]) {
    for (const round of [1, 2]) {
      const t = Date.now();
      const r: any[] = await page.evaluate(([m, n, k]) => (window as any).__lab(m, n, k, "r"), [
        mode,
        N,
        K,
      ] as const);
      const ok = r.filter((x) => x.ok);
      const errs = [...new Set(r.filter((x) => !x.ok).map((x) => x.error))];
      const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
      rows.push(
        `${mode.padEnd(16)} round ${round}: ${ok.length}/${N} ok in ${Date.now() - t} ms` +
          (ok.length
            ? `; per worker: init ${median(ok.map((x) => x.initMs))} ms, ${K} commits ${median(ok.map((x) => x.writeMs))} ms, rows ${median(ok.map((x) => Number(x.rows)))}`
            : "") +
          (errs.length ? `; errors: ${errs.join(" | ").slice(0, 300)}` : ""),
      );
      console.log(rows.at(-1));
    }
  }
});
