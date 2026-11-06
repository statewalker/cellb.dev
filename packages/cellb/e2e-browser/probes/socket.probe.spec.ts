import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../../src/project/browser-bundle.ts";
import { fixtureDir, partyConfig } from "../../test/partyserver/fixture.ts";

// WebSockets into a loaded Worker's isolate in Chromium (the browser half of
// bench/socket-bench.mjs): the partyserver extension of test/partyserver, in an isolate of its
// own. RUNS runs (default 3), each in a fresh page; BENCH_JSON=<file> writes the results.
test("WebSockets into a loaded Worker's isolate", async ({ browser }) => {
  test.setTimeout(900_000);
  const config = await partyConfig();
  const bundle = await bundleWorkerForBrowser(join(fixtureDir, "index.js"), { nodeCompat: true });
  const runs: Record<string, number>[] = [];
  for (let i = 0; i < Number(process.env.RUNS ?? 3); i++) {
    const page = await browser.newPage();
    await page.goto("/party/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const party = (op: object) => page.evaluate((o) => (window as any).__party(o), op);
    const run = `bench-${Date.now().toString(36)}`;
    const started = await party({ op: "start", config, bundle, run });
    if (!started.ok) throw new Error(started.error);
    const r = await party({ op: "bench", path: "/ext/notes", sockets: 1500 });
    if (!r.ok) throw new Error(r.error);
    const { failure, ...numbers } = r.result;
    if (failure) console.log(`run ${i + 1}: the concurrent sockets stopped: ${failure}`);
    runs.push(numbers);
    await page.close();
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const result = {
    date: new Date().toISOString().slice(0, 10),
    runs: runs.length,
    median: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(runs.map((r) => r[k]))])),
    all: runs,
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(result, null, 2)}\n`);
});
