import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { filesApiBackup } from "../src/adapters/files-backup.js";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import {
  type BackupInfo,
  type CellBackup,
  createCellRuntime,
  type OpenCellSql,
  runInDurableObject,
} from "../src/index.js";
import { FakeClock } from "./fake-clock.js";
import { worker } from "./fixtures.js";

const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
const drivers: [string, () => OpenCellSql][] = [
  ["node:sqlite", () => nodeSqliteOpener()],
  ["sqlite-wasm (oo1)", () => wasmMemoryOpener(sqlite3)],
];

const recording = () => {
  const saves: { cellKey: string; image: Uint8Array; info: BackupInfo }[] = [];
  const backup: CellBackup = {
    intervalMs: 1_000,
    save: async (cellKey, image, info) => void saves.push({ cellKey, image, info }),
  };
  return { saves, backup };
};

describe.each(drivers)("P06a periodic backup callback [%s]", (_n, opener) => {
  const rt = (backup: CellBackup, clock = new FakeClock()) => ({
    clock,
    rt: createCellRuntime({
      worker,
      durableObjects: { COUNTER: { className: "Counter" } },
      openSql: opener(),
      backup,
      clock,
    }),
  });
  const counter = (r: ReturnType<typeof createCellRuntime>, name: string) =>
    (r.env.COUNTER as any).getByName(name);

  it("saves only cells that changed, once per interval, with a growing seq", async () => {
    const { saves, backup } = recording();
    const { rt: r, clock } = rt(backup);
    await counter(r, "a").increment(1);
    await counter(r, "b").value(); // created, but nothing written after init
    await clock.advance(1_000);
    const first = saves.map((s) => s.cellKey);
    expect(first.some((k) => k.startsWith("Counter/"))).toBe(true);
    const n = saves.length;
    await clock.advance(1_000); // nothing changed
    expect(saves.length).toBe(n);
    await counter(r, "a").increment(1);
    await clock.advance(1_000);
    expect(saves.length).toBe(n + 1);
    expect(saves.at(-1)!.info.seq).toBeGreaterThan(saves[0].info.seq);
    expect(saves.at(-1)!.info.reason).toBe("interval");
    await r.close();
  });

  it("round trip through a FilesApi: a fresh runtime restores the cell on first access", async () => {
    const files = new MemFilesApi();
    const { rt: r1 } = rt(filesApiBackup(files, { intervalMs: 60_000 }));
    await counter(r1, "x").increment(7);
    await r1.backupNow();
    const { rt: r2 } = rt(filesApiBackup(files, { intervalMs: 60_000 })); // empty local storage
    expect(await counter(r2, "x").value()).toBe(7);
    expect(await counter(r2, "x").increment(1)).toBe(8);
  });

  it("RPO = interval: writes after the last save are lost with the local store", async () => {
    const files = new MemFilesApi();
    const { rt: r1, clock } = rt(filesApiBackup(files, { intervalMs: 1_000 }));
    await counter(r1, "y").increment(1);
    await clock.advance(1_000); // saved: 1
    await counter(r1, "y").increment(1); // not saved yet
    r1.evictAll(); // local store gone (crash / evicted OPFS), no final backup
    const { rt: r2 } = rt(filesApiBackup(files));
    expect(await counter(r2, "y").value()).toBe(1);
  });

  it("close() takes a final backup of changed cells", async () => {
    const files = new MemFilesApi();
    const { rt: r1 } = rt(filesApiBackup(files, { intervalMs: 60_000 }));
    await counter(r1, "z").increment(3);
    await r1.close();
    const { rt: r2 } = rt(filesApiBackup(files));
    expect(await counter(r2, "z").value()).toBe(3);
  });

  it("a failing save is reported, does not break the object, and is retried next interval", async () => {
    let fail = true;
    const errors: unknown[] = [];
    const saved: number[] = [];
    const backup: CellBackup = {
      intervalMs: 1_000,
      onError: (_k, e) => errors.push(e),
      save: async (_k, _img, info) => {
        if (fail) throw new Error("bucket unreachable");
        saved.push(info.seq);
      },
    };
    const { rt: r, clock } = rt(backup);
    await counter(r, "f").increment(1);
    await clock.advance(1_000);
    expect(errors.length).toBeGreaterThan(0);
    expect(await counter(r, "f").increment(1)).toBe(2); // object unaffected
    fail = false;
    await clock.advance(1_000);
    expect(saved.length).toBeGreaterThan(0);
    await r.close();
  });

  it("never snapshots in the middle of an async transaction()", async () => {
    const { saves, backup } = recording();
    const { rt: r, clock } = rt(backup);
    const stub = counter(r, "t");
    await stub.value();
    let release!: () => void;
    const inTxn = runInDurableObject(stub, (_o, ctx) =>
      ctx.storage.transaction(async (txn) => {
        await txn.put("half", 1);
        await new Promise<void>((res) => (release = res));
        await txn.put("other-half", 2);
      }),
    );
    await new Promise((res) => setTimeout(res, 10));
    const before = saves.length;
    await clock.advance(1_000);
    expect(saves.length).toBe(before); // skipped: the transaction holds the database
    release();
    await inTxn;
    await clock.advance(1_000);
    expect(saves.length).toBe(before + 1);
    await r.close();
  });
});
