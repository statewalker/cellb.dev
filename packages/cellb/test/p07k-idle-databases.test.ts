import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CellStorage,
  celldBucket,
  createCellRuntime,
  DurableObject,
  memoryObjectStore,
  type OpenCellSql,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

class Counter extends DurableObject {
  async inc() {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}

/** Counts the open SQLite handles of cells (the runtime's own alarm index aside). */
const counting = (inner: OpenCellSql) => {
  const handles = { open: 0 };
  const open: OpenCellSql = (cellKey) => {
    const d = inner(cellKey);
    if (cellKey.startsWith("__cellb/")) return d;
    handles.open++;
    const close = d.close.bind(d);
    d.close = () => {
      handles.open--;
      close();
    };
    return d;
  };
  return { open, handles };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = (openSql: OpenCellSql, storage?: CellStorage) => {
  const rt = createCellRuntime({
    worker: { Counter, default: {} },
    durableObjects: { COUNTER: { className: "Counter" } },
    openSql,
    storage,
    closeDatabaseAfterMs: 0,
  });
  return { rt, inc: () => (rt.env.COUNTER as any).getByName("c").inc() };
};

/** The reply can leave before the event's commit settles: sweep until the database closes. */
async function closeWhenIdle(
  rt: { hibernateIdle(ms: number): number; backupNow(): Promise<void> },
  handles: { open: number },
) {
  for (let i = 0; i < 200 && handles.open; i++) {
    await rt.backupNow();
    rt.hibernateIdle(0);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("P07k an idle cell closes its database and reopens it on the next event", () => {
  it("a database in a directory: closed when idle, reopened with its data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cellb-idle-"));
    dirs.push(dir);
    const { open, handles } = counting(nodeSqliteOpener(dir));
    const { rt, inc } = setup(open);
    expect(await inc()).toBe(1);
    expect(handles.open).toBe(1);
    await closeWhenIdle(rt, handles);
    expect(handles.open).toBe(0);
    expect(await inc()).toBe(2);
    expect(handles.open).toBe(1);
    await rt.close();
    expect(handles.open).toBe(0);
  });

  it("a database in memory on a fleet bucket: reopened empty, restored from the bucket", async () => {
    const { open, handles } = counting(nodeSqliteOpener());
    const { rt, inc } = setup(open, celldBucket(memoryObjectStore(), { node: "A" }));
    expect(await inc()).toBe(1);
    await closeWhenIdle(rt, handles);
    expect(handles.open).toBe(0);
    expect(await inc()).toBe(2);
    await rt.close();
  });
});
