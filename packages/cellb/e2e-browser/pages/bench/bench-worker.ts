/// <reference lib="webworker" />
// cellb's numbers in a browser: the runtime in a Dedicated Worker, cells in SQLite WASM on an
// OPFS pool (opfs-sahpool). The same Worker and rows as bench/node-bench.mjs, measured here.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../../../src/browser.js";
import { createCellRuntime, DurableObject } from "../../../src/index.js";

class Counter extends DurableObject {
  constructor(ctx: any, env: any) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS w (seq INTEGER PRIMARY KEY, at INTEGER)");
  }
  write(seq: number) {
    this.ctx.storage.sql.exec("INSERT INTO w (seq, at) VALUES (?, ?)", seq, Date.now());
    return seq;
  }
  read() {
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM w").one();
  }
}

const worker = {
  Counter,
  default: {
    async fetch(req: Request, env: any) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response("ok");
      const [, , name, op, arg] = url.pathname.split("/");
      const cell = env.COUNTER.getByName(name);
      if (op === "write") return Response.json(await cell.write(Number(arg)));
      if (op === "read") return Response.json(await cell.read());
      return new Response("not found", { status: 404 });
    },
  },
};

const now = () => performance.now();
const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
const stats = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  const r = (x: number) => Number(x.toFixed(3));
  return {
    n: s.length,
    p50Ms: r(q(s, 0.5)),
    p99Ms: r(q(s, 0.99)),
    meanMs: r(s.reduce((a, b) => a + b, 0) / s.length),
  };
};

self.onmessage = async (e) => {
  try {
    const cells = Number(e.data?.cells ?? 1000);
    const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const pool = `bench-${Date.now()}`;
    const openSql = await sahpoolOpener(sqlite3, { name: pool });
    const rt = createCellRuntime({
      worker: worker as any,
      durableObjects: { COUNTER: { className: "Counter" } },
      openSql,
      hibernateAfterMs: 3_600_000,
    });
    const get = (path: string) => rt.fetch(new Request(`http://bench${path}`));
    const wasmBytes = () => sqlite3.wasm.heap8u().byteLength as number;
    const jsHeap = () => (performance as any).memory?.usedJSHeapSize as number | undefined;

    // Stateless requests.
    for (let i = 0; i < 2_000; i++) await (await get("/")).text();
    const st: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const t = now();
      await (await get("/")).text();
      st.push(now() - t);
    }
    const t0 = now();
    let n = 0;
    await Promise.all(
      Array.from({ length: 64 }, async () => {
        while (now() - t0 < 3_000) {
          await (await get("/")).text();
          n++;
        }
      }),
    );
    const rps = Math.round(n / ((now() - t0) / 1000));

    // Writes to one cell: each commit is synced to OPFS before the reply leaves.
    await (await get("/cell/w/write/0")).text();
    const wr: number[] = [];
    for (let i = 1; i <= 2_000; i++) {
      const t = now();
      await (await get(`/cell/w/write/${i}`)).text();
      wr.push(now() - t);
    }

    // Resident cells: memory, then hibernate them all and wake each one.
    const wasm0 = wasmBytes();
    const heap0 = jsHeap();
    for (let i = 0; i < cells; i++) await (await get(`/cell/m${i}/write/1`)).text();
    const wasmPerCell = (wasmBytes() - wasm0) / cells;
    const heap1 = jsHeap();
    await new Promise((r) => setTimeout(r, 20));
    const slept = rt.hibernateIdle(0);
    const wk: number[] = [];
    for (let i = 0; i < cells; i++) {
      const t = now();
      const r = await (await get(`/cell/m${i}/read`)).json();
      wk.push(now() - t);
      if (r.n !== 1) throw new Error(`cell m${i}: ${JSON.stringify(r)}`);
    }
    await rt.close();
    const mb = (b: number) => Number((b / 1024 / 1024).toFixed(3));
    (self as any).postMessage({
      ok: true,
      result: {
        date: new Date().toISOString().slice(0, 10),
        userAgent: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        stateless: { ...stats(st), rps },
        opfsWrite: stats(wr),
        wake: { hibernated: slept, ...stats(wk) },
        memory: {
          cells,
          sqliteWasmPerCellMB: mb(wasmPerCell),
          jsHeapPerCellMB:
            heap0 !== undefined && heap1 !== undefined ? mb((heap1 - heap0) / cells) : null,
        },
      },
    });
  } catch (err) {
    (self as any).postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
