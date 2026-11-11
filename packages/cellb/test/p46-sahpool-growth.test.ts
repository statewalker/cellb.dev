import { describe, expect, it } from "vitest";
import { sahpoolOpener } from "../src/adapters/wasm-sqlite.js";

// sahpoolOpener (src/adapters/wasm-sqlite.ts) keeps cells' OPFS pool ahead of need. Each new
// slot is an OPFS file with a sync access handle, made one at a time, and once a worker is busy
// each takes seconds: a pool that grew only once full, by doubling, left a cell waiting for
// minutes (32 Flue conversations in one browser worker stalled). Here the pool is a fake around
// SQLite WASM's in-memory databases: its slots are counted, and growing it is recorded.
const sqlite = async () =>
  ((await import("@sqlite.org/sqlite-wasm")).default as any)({ print() {}, printErr() {} });

async function fakePool(initialCapacity: number, opts: { slowSteps?: boolean } = {}) {
  const s = await sqlite();
  const files = new Set<string>();
  const growths: { from: number; to: number }[] = [];
  let capacity = initialCapacity;
  let db = 0;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const later = () => {
    if (!opts.slowSteps) return new Promise((r) => setTimeout(r, 1));
    pending ??= new Promise<void>((r) => {
      release = () => {
        pending = undefined;
        r();
      };
    });
    return pending;
  };
  const pool = {
    OpfsSAHPoolDb: class extends s.oo1.DB {
      constructor(path: string) {
        if (!files.has(path) && files.size >= capacity) throw new Error("SAH pool is full");
        super(`file:/pool-${db++}?vfs=memdb`, "c");
        files.add(path);
      }
    },
    getCapacity: () => capacity,
    getFileCount: () => files.size,
    getFileNames: () => [...files],
    // Slots arrive later, as OPFS handles do (or when the test lets them, with `slowSteps`).
    reserveMinimumCapacity: async (min: number) => {
      await later();
      if (min > capacity) {
        growths.push({ from: capacity, to: min });
        capacity = min;
      }
      return capacity;
    },
    addCapacity: async (n: number) => {
      await later();
      growths.push({ from: capacity, to: capacity + n });
      capacity += n;
      return capacity;
    },
  };
  const sqlite3 = { ...s, installOpfsSAHPoolVfs: async () => pool };
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
  return {
    openSql,
    openCell,
    write,
    settle,
    growths,
    files,
    capacity: () => capacity,
    /** Completes the growth step waiting with `slowSteps`. */
    step: async () => {
      release?.();
      release = undefined;
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

describe("P46 the cells' OPFS pool grows ahead of need", () => {
  it("counts the journals open cells will make, before they make them", async () => {
    const p = await fakePool(16);
    for (let i = 0; i < 8; i++) await p.openCell(`c${i}`);
    await p.settle();
    // 8 databases and 8 journals to come: 16 slots, with two thirds of the pool free.
    expect(p.capacity()).toBeGreaterThanOrEqual(48);
    for (let i = 0; i < 8; i++) p.write(`c${i}`);
    expect(p.files.size).toBe(16);
    expect(p.capacity() - p.files.size).toBeGreaterThanOrEqual(p.capacity() / 2);
  });

  it("a cell that waits for room waits for one step of slots, not a doubling", async () => {
    const p = await fakePool(64);
    // 31 cells with their journals: 62 slots of 64, as if the background growth were behind.
    for (let i = 0; i < 31; i++) {
      p.openSql(`c${i}`);
      p.write(`c${i}`);
    }
    await p.settle();
    p.growths.length = 0;
    const before = p.capacity();
    await p.openCell("late");
    // A step's slots are asked for one at a time, in parallel: never more than 16 per step.
    for (const g of p.growths) expect(g.to - g.from).toBe(1);
    expect(p.capacity() - before).toBeLessThanOrEqual(16 * Math.ceil(p.growths.length / 16));
    expect(p.capacity()).toBeGreaterThanOrEqual(before);
  });

  it("a cell waits for what it needed when it asked, not for later reservations", async () => {
    const p = await fakePool(2, { slowSteps: true });
    let first = false;
    const a = p.openSql.room?.("a")?.then(() => {
      first = true;
    });
    // Ten more cells reserve while the first step is under way.
    for (let i = 0; i < 10; i++) void p.openSql.room?.(`later-${i}`);
    await p.step();
    expect(p.capacity()).toBeGreaterThanOrEqual(3);
    expect(first).toBe(true);
    await a;
  });

  it("a cell that reopens without room still makes the pool grow", async () => {
    const p = await fakePool(2);
    // Two cells fill the pool without asking for room (as a hibernated cell reopens).
    p.openSql("a");
    expect(() => p.openSql("b")).not.toThrow();
    expect(() => p.openSql("c")).toThrow(/SAH pool is full/);
    await p.settle();
    expect(p.capacity()).toBeGreaterThan(2);
    expect(() => p.openSql("c")).not.toThrow();
  });

  it("a closed cell no longer counts, and closing an older driver keeps the newer one", async () => {
    const p = await fakePool(16);
    const old = await p.openCell("c");
    await p.settle();
    const grown = p.growths.length;
    // The same cell opened again before the old driver is closed.
    const again = p.openSql("c");
    old.close();
    // `c` is still open and counted: its journal (1) and database (1) need 2, and 3 * 2 fit.
    await p.openCell("d");
    await p.settle();
    expect(p.growths.length).toBe(grown);
    again.close();
  });
});
