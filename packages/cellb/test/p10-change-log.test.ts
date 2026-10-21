import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import {
  createCellRuntime,
  DurableObject,
  filesApiChangeLog,
  runInDurableObject,
} from "../src/index.js";
import type { OpenCellSql } from "../src/ports.js";

/** Writes through every path: KV, SQL with and without PRIMARY KEY, DDL, rollbacks, alarms. */
class Ledger extends DurableObject {
  async fill(n: number) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, label TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS plain (label TEXT)"); // no PRIMARY KEY
    for (let i = 0; i < n; i++) {
      sql.exec("INSERT INTO entries (label) VALUES (?)", `e${i}`);
      sql.exec("INSERT INTO plain VALUES (?)", `p${i}`);
      await this.ctx.storage.put(`k${i}`, { i, at: new Date(0) });
    }
    sql.exec("UPDATE entries SET label = label || '!' WHERE id % 2 = 0");
    sql.exec("DELETE FROM plain WHERE label = 'p0'");
    try {
      this.ctx.storage.transactionSync(() => {
        sql.exec("INSERT INTO entries (label) VALUES ('rolled back')");
        sql.exec("INSERT INTO plain VALUES ('rolled back')");
        throw new Error("abort");
      });
    } catch {}
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
  async dump() {
    const sql = this.ctx.storage.sql;
    return {
      entries: sql.exec("SELECT id, label FROM entries ORDER BY id").toArray(),
      plain: sql.exec("SELECT label FROM plain ORDER BY label").toArray(),
      kv: [...(await this.ctx.storage.list()).entries()],
      alarm: (await this.ctx.storage.getAlarm()) !== null,
    };
  }
}

const runtime = (openSql: OpenCellSql, log: ReturnType<typeof filesApiChangeLog>) =>
  createCellRuntime({
    worker: { Ledger, default: {} },
    durableObjects: { LEDGER: { className: "Ledger" } },
    openSql,
    durability: log,
    backup: log,
  });

for (const [driverName, makeOpener] of [
  ["node:sqlite", async () => nodeSqliteOpener()],
  [
    "SQLite WASM",
    async () =>
      wasmMemoryOpener(
        await ((await import("@sqlite.org/sqlite-wasm")).default as any)({
          print() {},
          printErr() {},
        }),
      ),
  ],
] as const) {
  describe(`P10 transaction log on a FilesApi (${driverName})`, () => {
    it("a cell is rebuilt from the log alone on an empty database (no snapshot)", async () => {
      const files = new MemFilesApi();
      const a = runtime(await makeOpener(), filesApiChangeLog(files));
      const stub = (a.env.LEDGER as any).getByName("x");
      await runInDurableObject(stub, (o: Ledger) => o.fill(5));
      const before = await runInDurableObject(stub, (o: Ledger) => o.dump());
      // A different machine: fresh, empty databases; only the FilesApi survives.
      const b = runtime(await makeOpener(), filesApiChangeLog(files));
      const after = await runInDurableObject((b.env.LEDGER as any).getByName("x"), (o: Ledger) =>
        o.dump(),
      );
      expect(after).toEqual(before);
      expect(before.entries).toHaveLength(5);
      expect(before.plain.map((r: any) => r.label)).toEqual(["p1", "p2", "p3", "p4"]);
    });

    it("snapshot + newer segments; the snapshot compacts the segments it contains", async () => {
      const files = new MemFilesApi();
      const a = runtime(await makeOpener(), filesApiChangeLog(files));
      const stub = (a.env.LEDGER as any).getByName("y");
      await runInDurableObject(stub, (o: Ledger) => o.fill(3));
      await a.backupNow();
      const segs = async () => {
        const out: string[] = [];
        for await (const f of files.list("/cells", { recursive: true }))
          if (f.path.endsWith(".seg")) out.push(f.path);
        return out;
      };
      expect(await segs()).toEqual([]);
      await runInDurableObject(stub, (o: Ledger) => o.fill(2));
      expect((await segs()).length).toBeGreaterThan(0);
      const before = await runInDurableObject(stub, (o: Ledger) => o.dump());
      const b = runtime(await makeOpener(), filesApiChangeLog(files));
      expect(
        await runInDurableObject((b.env.LEDGER as any).getByName("y"), (o: Ledger) => o.dump()),
      ).toEqual(before);
    });
  });
}

describe("P10 durability and fencing", () => {
  it("a reply is released only after its segment is stored (output gate, RPO = 0)", async () => {
    const files = new MemFilesApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new Proxy(files, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        return p === "write" ? async (...a: unknown[]) => (await gate, (v as any).apply(t, a)) : v;
      },
    });
    const rt = runtime(nodeSqliteOpener(), filesApiChangeLog(slow as MemFilesApi));
    let answered = false;
    const p = runInDurableObject((rt.env.LEDGER as any).getByName("z"), async (_o, ctx) => {
      await ctx.storage.put("k", 1);
      return "done";
    }).then((v) => {
      answered = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);
    release();
    expect(await p).toBe("done");
  });

  it("segments of a stale owner are void from the first sequence a newer owner wrote", async () => {
    const files = new MemFilesApi();
    const old = runtime(nodeSqliteOpener(), filesApiChangeLog(files, { epoch: 1 }));
    const oldStub = (old.env.LEDGER as any).getByName("f");
    await runInDurableObject(oldStub, (_o, ctx) => ctx.storage.put("v", "first"));
    // Takeover: the new owner (epoch 2) restores from the log and writes.
    const neu = runtime(nodeSqliteOpener(), filesApiChangeLog(files, { epoch: 2 }));
    const newStub = (neu.env.LEDGER as any).getByName("f");
    expect(await runInDurableObject(newStub, (_o, ctx) => ctx.storage.get("v"))).toBe("first");
    await runInDurableObject(newStub, (_o, ctx) => ctx.storage.put("v", "new owner"));
    // The old owner does not know it lost the cell and writes late.
    await runInDurableObject(oldStub, (_o, ctx) => ctx.storage.put("v", "stale"));
    await runInDurableObject(oldStub, (_o, ctx) => ctx.storage.put("v", "stale again")); // beyond the new owner's seq
    const fresh = runtime(nodeSqliteOpener(), filesApiChangeLog(files, { epoch: 3 }));
    expect(
      await runInDurableObject((fresh.env.LEDGER as any).getByName("f"), (_o, ctx) =>
        ctx.storage.get("v"),
      ),
    ).toBe("new owner");
  });
});
