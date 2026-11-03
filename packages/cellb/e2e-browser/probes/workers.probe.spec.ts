import { writeFileSync } from "node:fs";
import { type Page, test } from "@playwright/test";
import { availableMB, chromiumMemory } from "./chromium-memory.ts";

// How many cell workers one tab runs, and how many cells they hold together. Each worker is the
// capacity probe's (pages/capacity): SQLite WASM with its own heap (at most 2 GiB) and its own
// OPFS pool, and a cellb runtime.
//
//   WORKERS_MAX=64 pnpm probes:browser workers -g "how many workers"
//   CAPACITY_WORKERS=4 CAPACITY_STEP=1000 pnpm probes:browser workers -g "cells across"
//
// Both stop before the machine runs short of memory: when less than WORKERS_RESERVE_MB
// (default 2048) is left. BENCH_JSON=<file> writes the result. Linux only (it reads /proc).

const reserveMB = Number(process.env.WORKERS_RESERVE_MB ?? 2_048);
const round = (x: number) => Math.round(x * 10) / 10;

async function open(page: Page) {
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  page.on("crash", () => console.log("[page] crashed"));
  await page.goto("/capacity/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  return (msg: object, i: number) =>
    page.evaluate(([m, w]) => (window as any).__capacity(m, w), [msg, i] as const);
}

function save(result: object) {
  console.log(JSON.stringify(result, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(result, null, 2)}\n`);
}

test("how many workers one tab runs", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const max = Number(process.env.WORKERS_MAX ?? 64);
  const call = await open(page);
  const base = chromiumMemory();
  const rows: any[] = [];
  let stopped = "max";
  for (let i = 0; i < max; i++) {
    if (availableMB() < reserveMB) {
      stopped = `machine memory: ${availableMB()} MB left`;
      break;
    }
    const t = Date.now();
    try {
      await call({ op: "init" }, i);
      await call({ op: "grow", n: 1 }, i);
    } catch (err) {
      stopped = String((err as Error).message)
        .split("\n")[0]
        .slice(0, 300);
      break;
    }
    rows.push({
      workers: i + 1,
      startMs: Date.now() - t,
      ...chromiumMemory(),
      availableMB: availableMB(),
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
  const last = rows.at(-1);
  save({
    date: new Date().toISOString().slice(0, 10),
    test: "workers",
    stopped,
    base,
    workers: last?.workers ?? 0,
    perWorkerChromiumMB: last
      ? round((last.chromiumPssMB - base.chromiumPssMB) / last.workers)
      : null,
    perWorkerRendererMB: last
      ? round((last.rendererPssMB - base.rendererPssMB) / last.workers)
      : null,
    rows,
  });
});

test("cells across workers", async ({ page }) => {
  const workers = Number(process.env.CAPACITY_WORKERS ?? 4);
  const step = Number(process.env.CAPACITY_STEP ?? 1_000);
  const budgetMs = Number(process.env.CAPACITY_BUDGET_MS ?? 25 * 60_000);
  test.setTimeout(budgetMs + 5 * 60_000);
  const call = await open(page);
  const base = chromiumMemory();
  const ids = Array.from({ length: workers }, (_, i) => i);
  await Promise.all(ids.map((i) => call({ op: "init" }, i)));

  // Every worker grows by `step` cells at once; a worker whose step fails (SQLite out of memory)
  // is full and stops growing. The run ends when every worker is full.
  const cells = ids.map(() => 0);
  const heapMB = ids.map(() => 0);
  const full = new Map<number, string>();
  const rows: any[] = [];
  let stopped = "every worker full";
  const t0 = Date.now();
  while (full.size < workers) {
    if (Date.now() - t0 > budgetMs) {
      stopped = "time budget";
      break;
    }
    if (availableMB() < reserveMB) {
      stopped = `machine memory: ${availableMB()} MB left`;
      break;
    }
    const t = Date.now();
    const growing = ids.filter((i) => !full.has(i));
    const results = await Promise.allSettled(growing.map((i) => call({ op: "grow", n: step }, i)));
    results.forEach((r, k) => {
      const i = growing[k];
      if (r.status === "fulfilled") {
        cells[i] = (r.value as any).cells;
        heapMB[i] = (r.value as any).sqliteWasmMB;
      } else
        full.set(
          i,
          String(r.reason?.message ?? r.reason)
            .split("\n")[0]
            .slice(0, 200),
        );
    });
    rows.push({
      cells: cells.reduce((a, b) => a + b, 0),
      perWorker: [...cells],
      sqliteWasmMB: round(heapMB.reduce((a, b) => a + b, 0)),
      stepMs: Date.now() - t,
      ...chromiumMemory(),
      availableMB: availableMB(),
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
  const last = rows.at(-1);
  save({
    date: new Date().toISOString().slice(0, 10),
    test: "cells across workers",
    workers,
    step,
    stopped,
    full: Object.fromEntries(full),
    base,
    cells: last?.cells ?? 0,
    perCellChromiumKB: last
      ? Math.round(((last.chromiumPssMB - base.chromiumPssMB) * 1024) / last.cells)
      : null,
    perCellSqliteWasmKB: last ? Math.round((last.sqliteWasmMB * 1024) / last.cells) : null,
    rows,
  });
});
