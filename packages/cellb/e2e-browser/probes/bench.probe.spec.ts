import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";

// cellb's numbers in Chromium (the browser half of bench/node-bench.mjs). Prints the results;
// BENCH_JSON=<file> also writes them. BENCH_CELLS sets how many cells are made resident.
test("benchmark in a Dedicated Worker", async ({ page }) => {
  test.setTimeout(600_000);
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  await page.goto("/bench/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const result = await page.evaluate(
    (cells) => (window as any).__bench({ cells }),
    Number(process.env.BENCH_CELLS ?? 1000),
  );
  console.log(JSON.stringify(result, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(result, null, 2)}\n`);
});
