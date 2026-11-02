/// <reference lib="webworker" />
// How many cells one shard worker holds: cells in SQLite WASM on an OPFS pool, made resident in
// steps (`grow`), then hibernated with their databases closed (`sleep`), then woken (`wake`).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../../../src/browser.js";
import { type CellRuntime, createCellRuntime, DurableObject } from "../../../src/index.js";

class Cell extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS w (seq INTEGER PRIMARY KEY, body TEXT)");
  }
  write(body: string) {
    this.ctx.storage.sql.exec("INSERT INTO w (body) VALUES (?)", body);
    return 1;
  }
  count() {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM w").one().n;
  }
}

type DurableObjectState = ConstructorParameters<typeof DurableObject>[0];
type Stub = { write(body: string): Promise<number>; count(): Promise<number> };
type Env = { CELL: { getByName(name: string): Stub } };

let rt: CellRuntime | undefined;
let sqlite3: { wasm: { heap8u(): Uint8Array } } | undefined;
let made = 0;

const stub = (i: number) => {
  if (!rt) throw new Error("not initialized");
  return (rt.env as unknown as Env).CELL.getByName(`c${i}`);
};
const snapshot = async () => {
  const est = await navigator.storage.estimate();
  return {
    cells: made,
    sqliteWasmMB: (sqlite3?.wasm.heap8u().byteLength ?? 0) / 2 ** 20,
    opfsMB: (est.usage ?? 0) / 2 ** 20,
    quotaMB: (est.quota ?? 0) / 2 ** 20,
  };
};

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  const port = e.ports[0] as MessagePort;
  const reply = (v: unknown) => port.postMessage({ ok: true, v });
  try {
    if (m.op === "init") {
      sqlite3 = await (sqlite3InitModule as unknown as (o: object) => Promise<never>)({
        print() {},
        printErr() {},
      });
      const openSql = await sahpoolOpener(sqlite3 as never, {
        name: `capacity-${crypto.randomUUID()}`,
      });
      rt = createCellRuntime({
        worker: { Cell, default: { fetch: () => new Response("ok") } } as never,
        durableObjects: { CELL: { className: "Cell" } },
        openSql,
        hibernateAfterMs: 3_600_000, // the probe hibernates by hand
        closeDatabaseAfterMs: 1,
      });
      reply(await snapshot());
    } else if (m.op === "grow") {
      // Make `n` more cells resident: each opens its database, creates a table, writes a row.
      const body = "x".repeat(m.bytes ?? 100);
      const t = performance.now();
      for (let i = 0; i < m.n; i++) await stub(made + i).write(body);
      made += m.n;
      reply({ ...(await snapshot()), stepMs: Math.round(performance.now() - t) });
    } else if (m.op === "sleep") {
      // Drop every instance and close every database: what an inactive cell costs.
      await new Promise((r) => setTimeout(r, 20));
      const slept = rt?.hibernateIdle(0);
      reply({ ...(await snapshot()), slept });
    } else if (m.op === "wake") {
      // Read a sample of cells back; each reopens its database.
      const t = performance.now();
      let ok = 0;
      for (const i of m.sample as number[]) if ((await stub(i).count()) === 1) ok++;
      reply({ ...(await snapshot()), ok, perCellMs: (performance.now() - t) / m.sample.length });
    }
  } catch (err) {
    port.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
