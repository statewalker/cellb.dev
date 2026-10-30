import { expect, test } from "@playwright/test";

// Durable Objects on N shard workers with in-memory SQLite and an IndexedDB bucket: many cells
// written at once, then the page reloaded (every worker and its memory gone) and read back.
test("cells in memory + IndexedDB bucket: parallel shards, persistence across a reload", async ({
  page,
}) => {
  test.setTimeout(300_000);
  page.on(
    "console",
    (m) => m.type() === "error" && console.log(`[page] ${m.text().slice(0, 300)}`),
  );
  const SHARDS = Number(process.env.CELLS_SHARDS ?? 8);
  const CELLS = 48;
  const HITS = 10;
  const open = async () => {
    await page.goto(
      `/__cellb/cells-lab.html?shards=${SHARDS}&storage=${process.env.CELLS_STORAGE ?? "idb"}`,
    );
    await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
      timeout: 120_000,
    });
    return page.evaluate(() => (window as any).__startMs);
  };
  console.log(`started ${SHARDS} shards in ${await open()} ms`);
  const t = Date.now();
  const written = await page.evaluate(
    async ([cells, hits]) => {
      const one = async (c: number) => {
        let last = 0;
        for (let i = 0; i < hits; i++)
          last = (await (await fetch(`/__cellb/projects/counter/c${c}`, { method: "POST" })).json())
            .n;
        return last;
      };
      return Promise.all(Array.from({ length: cells }, (_, c) => one(c)));
    },
    [CELLS, HITS] as const,
  );
  console.log(`${CELLS} cells × ${HITS} writes in ${Date.now() - t} ms over ${SHARDS} shards`);
  expect(written.every((n) => n === HITS)).toBe(true);

  await page.reload(); // every shard worker and its in-memory databases are gone
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 120_000,
  });
  const t2 = Date.now();
  const read = await page.evaluate(
    async (cells) =>
      Promise.all(
        Array.from(
          { length: cells },
          async (_, c) => (await (await fetch(`/__cellb/projects/counter/c${c}`)).json()).n,
        ),
      ),
    CELLS,
  );
  console.log(`read back ${CELLS} cells in ${Date.now() - t2} ms: ${[...new Set(read)].join(",")}`);
  expect(read.every((n) => n === HITS)).toBe(true);
});
