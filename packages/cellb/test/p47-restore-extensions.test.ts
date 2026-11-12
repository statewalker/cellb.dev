import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../src/adapters/node-sqlite.js";
import { createCellRuntime, filesApiBackup, runInDurableObject } from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import { FakeClock } from "./fake-clock.js";
import { worker } from "./fixtures.js";

/**
 * restore() opens a new connection on the restored file. Extensions loaded before (a cell's
 * `sqlExtensions`, loaded at open, before the backup is restored) must be there again, and
 * SQL must still not be able to load a library by itself.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(join(tmpdir(), "cellb-p47-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};

const image = () => {
  const src = new NodeSqliteDriver();
  src.exec("CREATE TABLE t (x)", []);
  src.exec("INSERT INTO t VALUES (42)", []);
  const img = src.image();
  src.close();
  return img;
};

const cases: [string, () => NodeSqliteDriver][] = [
  ["in memory", () => new NodeSqliteDriver()],
  ["a file", () => new NodeSqliteDriver(file())],
  [
    "an exclusive file with page capture",
    () => new NodeSqliteDriver(file(), { exclusive: true, pageCapture: true }),
  ],
  ["a temporary file", () => new NodeSqliteDriver(file(), { temporary: true, pageCapture: true })],
];

describe("p47 restore keeps loaded extensions", () => {
  for (const [name, open] of cases) {
    it(`${name}: sqlite_vec works after restore()`, () => {
      const d = open();
      try {
        d.loadExtension("sqlite_vec");
        expect(String(d.exec("SELECT vec_version()", []).rows[0][0])).toMatch(/^v/);
        d.restore(image());
        expect(Number(d.exec("SELECT x FROM t", []).rows[0][0])).toBe(42);
        expect(String(d.exec("SELECT vec_version()", []).rows[0][0])).toMatch(/^v/);
        // A second restore keeps them too.
        d.restore(image());
        expect(String(d.exec("SELECT vec_version()", []).rows[0][0])).toMatch(/^v/);
      } finally {
        d.close();
      }
    });
  }

  it("does not load extensions that were never loaded", () => {
    const d = new NodeSqliteDriver();
    try {
      d.restore(image());
      expect(() => d.exec("SELECT vec_version()", [])).toThrow(/no such function/);
    } finally {
      d.close();
    }
  });

  it("SQL still cannot load a library after restore()", () => {
    const d = new NodeSqliteDriver();
    try {
      d.loadExtension("sqlite_vec");
      d.restore(image());
      expect(() => d.exec("SELECT load_extension('/nonexistent/lib')", [])).toThrow(
        /not authorized/,
      );
    } finally {
      d.close();
    }
  });
});

describe("p47 a cell restored from a backup keeps its sqlExtensions", () => {
  const rt = (files: MemFilesApi) =>
    createCellRuntime({
      worker,
      durableObjects: { COUNTER: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: { backup: filesApiBackup(files, { intervalMs: 60_000 }) },
      sqlExtensions: ["sqlite_vec"],
      clock: new FakeClock(),
    });
  const counter = (r: ReturnType<typeof createCellRuntime>, name: string) =>
    (r.env.COUNTER as any).getByName(name);

  it("a fresh runtime restores the cell, and vec_version() works in it", async () => {
    const files = new MemFilesApi();
    const r1 = rt(files);
    await counter(r1, "v").increment(3);
    await r1.backupNow();
    await r1.close();
    const r2 = rt(files); // empty local storage: the cell is restored from `files`
    try {
      expect(await counter(r2, "v").value()).toBe(3);
      const version = await runInDurableObject(counter(r2, "v"), (_o, ctx: any) =>
        String(ctx.storage.sql.exec("SELECT vec_version() AS v").one().v),
      );
      expect(version).toMatch(/^v/);
    } finally {
      await r2.close();
    }
  });
});
