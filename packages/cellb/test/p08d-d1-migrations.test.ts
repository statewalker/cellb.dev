import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { applyNodeD1Migrations, loadNodeProject } from "../src/project/node-project.js";

// celld's rules (celld d1 --help): NNNN_description.sql, case-insensitive extension, numeric
// order, migrations_dir / migrations_table, wrangler's d1_migrations table.
describe("P08d D1 migrations", () => {
  it("applies new files in numeric order, records them, and skips applied ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d1mig-"));
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "m",
        main: "index.js",
        d1_databases: [
          { binding: "DB", database_name: "main", database_id: "db-1", migrations_dir: "sql" },
        ],
      }),
    );
    writeFileSync(
      join(dir, "index.js"),
      "export default { fetch() { return new Response('ok') } }",
    );
    mkdirSync(join(dir, "sql"));
    writeFileSync(join(dir, "sql", "0010_more.SQL"), "ALTER TABLE t ADD COLUMN b TEXT;");
    writeFileSync(
      join(dir, "sql", "0002_init.sql"),
      "CREATE TABLE t (a INTEGER);\nINSERT INTO t (a) VALUES (1);",
    );
    writeFileSync(join(dir, "sql", "notes.txt"), "ignored");
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    expect(await applyNodeD1Migrations(dir, runtime, "main")).toEqual([
      "0002_init.sql",
      "0010_more.SQL",
    ]);
    expect(await applyNodeD1Migrations(dir, runtime, "main")).toEqual([]);
    writeFileSync(join(dir, "sql", "0011_add.sql"), "INSERT INTO t (a, b) VALUES (2, 'x');");
    expect(await applyNodeD1Migrations(dir, runtime, "main")).toEqual(["0011_add.sql"]);
    const db = runtime.env.DB as any;
    expect((await db.prepare("SELECT a, b FROM t ORDER BY a").all()).results).toEqual([
      { a: 1, b: null },
      { a: 2, b: "x" },
    ]);
    expect((await db.prepare("SELECT name FROM d1_migrations ORDER BY id").raw()).flat()).toEqual([
      "0002_init.sql",
      "0010_more.SQL",
      "0011_add.sql",
    ]);
  });
});
