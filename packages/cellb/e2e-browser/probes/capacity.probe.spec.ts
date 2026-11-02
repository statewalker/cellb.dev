import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";

// How many cells one browser worker holds, and what they cost. The worker makes cells resident
// in steps (a table and a row each, in SQLite WASM on an OPFS pool) until a step fails, the
// count reaches CAPACITY_MAX, or the time runs out; after each step this probe reads the memory
// of Chromium's processes from /proc (PSS: shared pages divided among the processes sharing
// them). Then every cell is hibernated with its database closed, and a sample is woken.
//
//   CAPACITY_STEP=2000 CAPACITY_MAX=100000 BENCH_JSON=bench/results/chromium-capacity.json \
//     pnpm probes:browser capacity
//
// Linux only (it reads /proc).

/** PSS of every Chromium process, in MB; `renderer` is the largest renderer (the page's). */
function chromiumMemory() {
  let total = 0;
  let renderer = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/chrom/i.test(cmd.split("\0")[0] ?? "")) continue;
      const pss = Number(
        /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0,
      );
      total += pss;
      if (cmd.includes("--type=renderer")) renderer = Math.max(renderer, pss);
    } catch {
      // the process exited, or is not ours to read
    }
  }
  return { chromiumPssMB: Math.round(total / 1024), rendererPssMB: Math.round(renderer / 1024) };
}

const round = (x: number) => Math.round(x * 10) / 10;

test("cells in one browser worker: how many, and their memory", async ({ page }) => {
  const step = Number(process.env.CAPACITY_STEP ?? 2_000);
  const max = Number(process.env.CAPACITY_MAX ?? 100_000);
  const budgetMs = Number(process.env.CAPACITY_BUDGET_MS ?? 20 * 60_000);
  test.setTimeout(budgetMs + 5 * 60_000);
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  page.on("crash", () => console.log("[page] crashed"));
  await page.goto("/capacity/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");

  const call = (msg: object) => page.evaluate((m) => (window as any).__capacity(m), msg);
  const row = (v: any, extra: object = {}) => ({
    cells: v.cells,
    sqliteWasmMB: round(v.sqliteWasmMB),
    opfsMB: round(v.opfsMB),
    ...chromiumMemory(),
    ...extra,
  });

  const base = row(await call({ op: "init" }));
  console.log("base", JSON.stringify(base));
  const steps: any[] = [];
  const t0 = Date.now();
  let stopped = "max";
  while (steps.length === 0 || steps.at(-1).cells < max) {
    if (Date.now() - t0 > budgetMs) {
      stopped = "time budget";
      break;
    }
    try {
      const v: any = await call({ op: "grow", n: step });
      steps.push(row(v, { stepMs: v.stepMs }));
      console.log(JSON.stringify(steps.at(-1)));
    } catch (err) {
      stopped = String((err as Error).message)
        .split("\n")[0]
        .slice(0, 300);
      console.log(`stopped: ${stopped}`);
      break;
    }
  }

  const last = steps.at(-1);
  const resident = last
    ? {
        cells: last.cells,
        perCellChromiumKB: Math.round(
          ((last.chromiumPssMB - base.chromiumPssMB) * 1024) / last.cells,
        ),
        perCellRendererKB: Math.round(
          ((last.rendererPssMB - base.rendererPssMB) * 1024) / last.cells,
        ),
        perCellSqliteWasmKB: Math.round(
          ((last.sqliteWasmMB - base.sqliteWasmMB) * 1024) / last.cells,
        ),
        perCellOpfsKB: Math.round(((last.opfsMB - base.opfsMB) * 1024) / last.cells),
      }
    : undefined;

  // Inactive: every instance dropped and every database closed; then a sample woken.
  let asleep: any;
  let woken: any;
  try {
    asleep = row(await call({ op: "sleep" }));
    await page.waitForTimeout(2_000);
    asleep = { ...asleep, ...chromiumMemory() };
    const n = last?.cells ?? 0;
    const sample = Array.from({ length: Math.min(500, n) }, (_, i) =>
      Math.floor((i * n) / Math.min(500, n)),
    );
    const v: any = await call({ op: "wake", sample });
    woken = row(v, { ok: v.ok, of: sample.length, perCellMs: round(v.perCellMs) });
  } catch (err) {
    asleep ??= { error: String(err).slice(0, 300) };
  }

  const result = {
    date: new Date().toISOString().slice(0, 10),
    userAgent: await page.evaluate(() => navigator.userAgent),
    step,
    stopped,
    base,
    resident,
    asleep,
    woken,
    steps,
  };
  console.log(JSON.stringify({ ...result, steps: undefined }, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(result, null, 2)}\n`);
});
