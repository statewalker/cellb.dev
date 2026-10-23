import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { memoryObjectStore, type ObjectStore } from "../src/bucket/object-store.js";
import { sqliteObjectStore } from "../src/bucket/sqlite-object-store.js";
import { createCellRuntime, DurableObject, runInDurableObject } from "../src/index.js";
import { loadNodeProject } from "../src/project/node-project.js";

// Hand-over while BOTH runtimes are up (celld dev and webrun-cells on one bucket): each refuses
// a cell whose owner is live, the cell moves only when its owner stops or loses its lease, and a
// node that cannot renew its lease stops acknowledging before the other may take over.
const CELLD = process.env.CELLD_BIN;
const counter = join(__dirname, "../conformance/celld-examples/counter");

async function celldDev(dir: string, port: number) {
  const p = spawn(CELLD!, ["dev", ".", "--port", String(port), "--logs"], {
    cwd: dir,
    env: { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("ready"); i++)
    await new Promise((r) => setTimeout(r, 200));
  return { p, base: `http://127.0.0.1:${port}`, log: () => log };
}
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => (p.once("exit", () => r()), p.kill("SIGTERM")));
const inc = async (f: (u: string) => Promise<Response>) => {
  const text = await (await f("/increment?name=a")).text();
  try {
    return { n: JSON.parse(text).n as number };
  } catch {
    return { refused: text };
  }
};
async function webrun(dir: string, store: ObjectStore, node: string) {
  const bucket = celldBucket(store, { node, leaseTtlMs: 3_000 });
  const { runtime } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
    ownership: bucket.ownership,
    durability: bucket.durability,
    backup: bucket.durability,
    bucketStore: store,
  } as never);
  return {
    inc: () => inc((u) => runtime.fetch(new Request(`http://w${u}`))),
    close: async () => (await runtime.close(), await bucket.close()),
  };
}
const until = async <T>(f: () => Promise<T>, ok: (v: T) => boolean, ms: number) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
};

describe.skipIf(!CELLD)("P11i live hand-over between celld and webrun-cells", () => {
  it("each refuses a live owner's cell; the cell moves when its owner stops; celld reads our node record", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "live-")), "counter");
    cpSync(counter, dir, { recursive: true });
    const c1 = await celldDev(dir, 18_860);
    expect(await inc((u) => fetch(c1.base + u))).toEqual({ n: 1 });
    const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
    const w = await webrun(dir, store, "webrun-live");
    expect(await w.inc()).toEqual({ refused: expect.stringContaining("owned by another") }); // celld is live
    expect(await inc((u) => fetch(c1.base + u))).toEqual({ n: 2 }); // celld keeps serving
    await stop(c1.p);
    // celld's node lease expires (~10 s), then webrun-cells takes the cell over.
    expect(
      await until(
        () => w.inc(),
        (r) => "n" in r,
        20_000,
      ),
    ).toEqual({ n: 3 });
    const c2 = await celldDev(dir, 18_862);
    try {
      const refused = await inc((u) => fetch(c2.base + u)); // webrun-cells is live: celld refuses
      expect(refused, JSON.stringify(refused)).toEqual({
        refused: expect.stringContaining("owner is currently unreachable"),
      });
      expect(await w.inc()).toEqual({ n: 4 });
      await w.close(); // releases the lease record: celld may take over at once
      expect(
        await until(
          () => inc((u) => fetch(c2.base + u)),
          (r) => "n" in r,
          15_000,
        ),
      ).toEqual({ n: 5 });
      // our node record decodes in celld (a malformed one breaks its fleet posture repair)
      expect(c2.log()).not.toMatch(/posture repair failed error=decode/);
    } finally {
      await stop(c2.p);
      store.close();
    }
  }, 120_000);

  it("a webrun-cells node cut off from the bucket fences itself; celld takes the cell over, no split brain", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "partition-")), "counter");
    cpSync(counter, dir, { recursive: true });
    const c0 = await celldDev(dir, 18_864);
    await stop(c0.p); // the bucket exists; celld's own lease will expire
    const real = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
    let partitioned = false;
    const store: ObjectStore = {
      get: (k) => (partitioned ? Promise.reject(new Error("partition")) : real.get(k)),
      put: (k, b, c, a) =>
        partitioned ? Promise.reject(new Error("partition")) : real.put(k, b, c, a),
      list: (p) => (partitioned ? Promise.reject(new Error("partition")) : real.list(p)),
      delete: (k) => (partitioned ? Promise.reject(new Error("partition")) : real.delete(k)),
    };
    const w = await webrun(dir, store, "webrun-cut");
    expect(
      await until(
        () => w.inc(),
        (r) => "n" in r,
        20_000,
      ),
    ).toEqual({ n: 1 });
    partitioned = true;
    // Within the lease TTL (3 s) every cell stops: nothing more is acknowledged.
    await new Promise((r) => setTimeout(r, 3_500));
    expect(await w.inc()).toEqual({ refused: expect.any(String) });
    const c1 = await celldDev(dir, 18_866);
    try {
      expect(
        await until(
          () => inc((u) => fetch(c1.base + u)),
          (r) => "n" in r,
          15_000,
        ),
      ).toEqual({ n: 2 });
      partitioned = false; // the partition heals: the old owner still refuses (celld owns it)
      expect(await w.inc()).toEqual({ refused: expect.any(String) });
      expect(await inc((u) => fetch(c1.base + u))).toEqual({ n: 3 });
    } finally {
      await w.close().catch(() => {});
      await stop(c1.p);
      real.close();
    }
  }, 120_000);
});

// Without celld: the local deadline. A node whose clock passes its lease's validity (a paused
// process resuming late) refuses to acknowledge — before anyone else could take over.
class Counter extends DurableObject {
  bump() {
    const n = (this.ctx.storage.kv.get<number>("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }
}
describe("P11i self-fencing at the lease deadline", () => {
  it("writes are refused once now() passes the lease's validity", async () => {
    let skew = 0;
    const bucket = celldBucket(memoryObjectStore(), {
      node: "n",
      leaseTtlMs: 3_000,
      now: () => Date.now() + skew,
    });
    const rt = createCellRuntime({
      worker: { Counter, default: {} },
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      ownership: bucket.ownership,
      durability: bucket.durability,
      backup: bucket.durability,
    });
    const stub = (rt.env.C as any).getByName("c");
    expect(await runInDurableObject(stub, (o: Counter) => o.bump())).toBe(1);
    skew = 5_000; // the process "slept" past its lease
    await expect(runInDurableObject(stub, (o: Counter) => o.bump())).rejects.toThrow(
      /lapsed|deadline|lost/,
    );
    await rt.close();
    await bucket.close();
  });
});
