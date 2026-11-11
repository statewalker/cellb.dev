import { describe, expect, it } from "vitest";
import { sahpoolOpener } from "../src/adapters/wasm-sqlite.js";

// sahpoolOpener (src/adapters/wasm-sqlite.ts) keeps cells' OPFS pool ahead of need. Each new
// slot is an OPFS file with a sync access handle, made one at a time, and once a worker is busy
// each takes seconds: a pool that grew only once full, by doubling, left a cell waiting for
// minutes (32 Flue conversations in one browser worker stalled). Here the pool is a fake around
// SQLite WASM's in-memory databases: its slots are counted, and growing it is recorded.
const sqlite = async () =>
  ((await import("@sqlite.org/sqlite-wasm")).default as any)({ print() {}, printErr() {} });

async function fakePool(initialCapacity: number) {
  const s = await sqlite();
  const files = new Set<string>();
  const growths: { from: number; to: number }[] = [];
  let capacity = 0;
  let db = 0;
  const pool = {
    OpfsSAHPoolDb: class extends s.oo1.DB {
      constructor(path: string) {
        super(`file:/pool-${db++}?vfs=memdb`, "c");
        files.add(path);
      }
    },
    getCapacity: () => capacity,
    getFileCount: () => files.size,
    getFileNames: () => [...files],
    // Slots arrive later, as OPFS handles do.
    reserveMinimumCapacity: async (min: number) => {
      await new Promise((r) => setTimeout(r, 1));
      if (min > capacity) {
        growths.push({ from: capacity, to: min });
        capacity = min;
      }
      return capacity;
    },
  };
  const sqlite3 = { ...s, installOpfsSAHPoolVfs: async () => pool };
  capacity = initialCapacity;
  const openSql = await sahpoolOpener(sqlite3 as never, { initialCapacity });
  /** Lets the pool's background growth finish. */
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
  };
  /** Opens a cell as the runtime does: room first, then the database. */
  const openCell = async (key: string) => {
    await openSql.room?.(key);
    return openSql(key);
  };
  /** The journal SQLite makes in the pool at the cell's first write. */
  const write = (key: string) => files.add(`/${key}.sqlite-journal`);
  return { openSql, openCell, write, settle, growths, files, capacity: () => capacity };
}

describe("P46 the cells' OPFS pool grows ahead of need", () => {
  it("counts the journals open cells will make, before they make them", async () => {
    const p = await fakePool(16);
    for (let i = 0; i < 6; i++) await p.openCell(`c${i}`);
    await p.settle();
    // 6 databases, 6 journals to come and a spare each: 18 slots, with half the pool free.
    expect(p.capacity()).toBeGreaterThanOrEqual(36);
    for (let i = 0; i < 6; i++) p.write(`c${i}`);
    expect(p.files.size).toBe(12);
    expect(p.capacity() - p.files.size).toBeGreaterThanOrEqual(p.capacity() / 2);
  });

  it("a cell that waits for room waits for small steps, not a doubling", async () => {
    const p = await fakePool(64);
    // Fill the pool: 21 cells with their journals (63 slots of 64, as cells opened while the
    // background growth was still behind).
    for (let i = 0; i < 21; i++) {
      p.openSql(`c${i}`);
      p.write(`c${i}`);
    }
    p.growths.length = 0;
    await p.openCell("late");
    expect(p.growths.length).toBeGreaterThan(0);
    for (const g of p.growths) expect(g.to - g.from).toBeLessThanOrEqual(8);
  });

  it("a closed cell no longer counts", async () => {
    const p = await fakePool(16);
    const cells = [];
    for (let i = 0; i < 4; i++) cells.push(await p.openCell(`c${i}`));
    await p.settle();
    for (const c of cells) c.close();
    const grown = p.growths.length;
    // Four databases stay in the pool (12 of 24 free after the growth); nothing more to grow.
    await p.openCell("again");
    await p.settle();
    expect(p.growths.length).toBe(grown);
  });
});
