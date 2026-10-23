import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import {
  createCellRuntime,
  DurableObject,
  decodeLtx,
  filesApiLtxLog,
  runInDurableObject,
} from "../src/index.js";
import type { OpenCellSql } from "../src/ports.js";

class Notes extends DurableObject {
  add(text: string) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
    sql.exec("INSERT INTO notes (text) VALUES (?)", text);
    this.ctx.storage.kv.put("last", text);
  }
  seed(n: number) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bulk (id INTEGER PRIMARY KEY, text TEXT)");
    for (let i = 0; i < n; i++)
      sql.exec("INSERT INTO bulk (text) VALUES (?)", `row ${i} `.repeat(20));
  }
  dump() {
    return {
      notes: this.ctx.storage.sql
        .exec("SELECT text FROM notes ORDER BY id")
        .toArray()
        .map((r: any) => r.text),
      last: this.ctx.storage.kv.get("last"),
    };
  }
}
const runtime = (openSql: OpenCellSql, log: ReturnType<typeof filesApiLtxLog>) =>
  createCellRuntime({
    worker: { Notes, default: {} },
    durableObjects: { NOTES: { className: "Notes" } },
    openSql,
    durability: log,
    backup: log,
  });
const ltxFiles = async (files: MemFilesApi) => {
  const out: { path: string; bytes: Uint8Array }[] = [];
  for await (const f of files.list("/cells", { recursive: true }))
    if (f.path.endsWith(".ltx")) {
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(f.path)) chunks.push(c);
      out.push({ path: f.path, bytes: new Uint8Array(Buffer.concat(chunks)) });
    }
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

for (const [name, opener] of [
  ["node:sqlite (file)", async () => nodeSqliteOpener(mkdtempSync(join(tmpdir(), "ltx-node-")))],
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
  describe(`P11b page-level log in LTX v3 (${name})`, () => {
    it("one LTX file per transaction (snapshot first, then changed pages); a fresh node restores", async () => {
      const files = new MemFilesApi();
      const a = runtime(await opener(), filesApiLtxLog(files));
      const stub = (a.env.NOTES as any).getByName("n");
      await runInDurableObject(stub, (o: Notes) => o.seed(300)); // many pages, so a later insert touches few
      for (const t of ["alpha", "beta", "gamma"])
        await runInDurableObject(stub, (o: Notes) => o.add(t));
      const before = await runInDurableObject(stub, (o: Notes) => o.dump());
      const written = await ltxFiles(files);
      expect(written.length).toBeGreaterThanOrEqual(3);
      const first = decodeLtx(written[0].bytes);
      expect(first.header.minTXID).toBe(1n);
      expect(first.pages.size).toBe(first.header.commit); // a snapshot: every page
      const lastFile = decodeLtx(written.at(-1)!.bytes); // decodeLtx verifies celld's file checksum
      expect(lastFile.header.minTXID).toBe(lastFile.header.maxTXID);
      expect(lastFile.pages.size).toBeLessThan(lastFile.header.commit); // only the changed pages
      const b = runtime(await opener(), filesApiLtxLog(files));
      expect(
        await runInDurableObject((b.env.NOTES as any).getByName("n"), (o: Notes) => o.dump()),
      ).toEqual(before);
    });

    it("compaction: a snapshot file 1..N replaces the files it contains; later commits continue", async () => {
      const files = new MemFilesApi();
      const log = filesApiLtxLog(files);
      const a = runtime(await opener(), log);
      const stub = (a.env.NOTES as any).getByName("c");
      for (const t of ["one", "two", "three"])
        await runInDurableObject(stub, (o: Notes) => o.add(t));
      await a.backupNow();
      const compacted = await ltxFiles(files);
      expect(compacted.length).toBe(1);
      const snap = decodeLtx(compacted[0].bytes);
      expect(snap.header.minTXID).toBe(1n);
      await runInDurableObject(stub, (o: Notes) => o.add("four"));
      const b = runtime(await opener(), filesApiLtxLog(files));
      expect(
        (await runInDurableObject((b.env.NOTES as any).getByName("c"), (o: Notes) => o.dump()))
          .notes,
      ).toEqual(["one", "two", "three", "four"]);
    });
  });
}
