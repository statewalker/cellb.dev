import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  celldBucket,
  createCellRuntime,
  DurableObject,
  memoryObjectStore,
  type ObjectStore,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

class Counter extends DurableObject {
  async inc() {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
  /** Rows a foreign key ties together: dropping the parent first must not fail. */
  link() {
    this.ctx.storage.sql.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
      CREATE TABLE ch (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id));
      INSERT INTO p VALUES (1); INSERT INTO ch VALUES (1, 1);`);
  }
  tables() {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name IN ('p', 'ch')")
      .toArray().length;
  }
}

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "cellb-stale-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A node of a fleet: its own celldBucket on the shared store, local SQLite files in `dir`. */
const node = (name: string, store: ObjectStore, dir: string) =>
  createCellRuntime({
    worker: { Counter, default: {} },
    durableObjects: { COUNTER: { className: "Counter" } },
    openSql: nodeSqliteOpener(dir),
    storage: celldBucket(store, { node: name }),
  });
const inc = (rt: ReturnType<typeof node>) => (rt.env.COUNTER as any).getByName("c").inc();

describe("P10e a node's local database is brought to the bucket's state when it takes a cell", () => {
  it("A, then B, then A again: A continues from B's writes, not from its own old file", async () => {
    const store = memoryObjectStore();
    const dirA = tempDir();
    const a1 = node("A", store, dirA);
    expect(await inc(a1)).toBe(1);
    await a1.close();
    const b = node("B", store, tempDir());
    expect(await inc(b)).toBe(2);
    await b.close();
    const a2 = node("A", store, dirA); // A's file still says 1
    expect(await inc(a2)).toBe(3);
    await a2.close();
  });

  it("a local database the bucket does not know (never durable) is dropped, not served", async () => {
    const dir = tempDir();
    const a1 = node("A", memoryObjectStore(), dir);
    expect(await inc(a1)).toBe(1);
    await (a1.env.COUNTER as any).getByName("c").link();
    await a1.close();
    const a2 = node("A", memoryObjectStore(), dir); // an empty bucket, the same local file
    expect(await inc(a2)).toBe(1);
    expect(await (a2.env.COUNTER as any).getByName("c").tables()).toBe(0);
    await a2.close();
  });
});

/** A remote store: each operation takes a macrotask, and none succeeds after close(). */
const slowStore = (inner: ObjectStore) => {
  let closed = false;
  const slow =
    <A extends unknown[], R>(op: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      await new Promise((r) => setTimeout(r, 5));
      if (closed) throw new Error("store closed");
      return op(...a);
    };
  return {
    get: slow(inner.get),
    put: slow(inner.put),
    list: slow(inner.list),
    delete: slow(inner.delete),
    close: () => {
      closed = true;
    },
  };
};

describe("P10e closing a runtime releases its cells before the store closes", () => {
  it("own.json is released when close() returns, and the next node takes the cell at once", async () => {
    const shared = memoryObjectStore();
    const a = node("A", slowStore(shared), tempDir());
    expect(await inc(a)).toBe(1);
    await a.close();
    const own = await shared.list("cells/");
    const record = own.find((k) => k.endsWith("/own.json"))!;
    expect(JSON.parse(new TextDecoder().decode((await shared.get(record))!.body))).toEqual({
      node: "",
      epoch: 1,
    });
    const b = node("B", shared, tempDir());
    expect(await inc(b)).toBe(2);
    await b.close();
  });
});
