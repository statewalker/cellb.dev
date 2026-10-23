import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { sqliteObjectStore } from "../src/bucket/sqlite-object-store.js";
import { loadNodeProject } from "../src/project/node-project.js";

// Moves a Durable Object between the real celld and webrun-cells through ONE bucket (celld
// dev's local objects.sqlite3): celld → webrun-cells → celld, each side restoring the
// other's LTX files under celld's keys, ownership passed with epochs.
const CELLD = process.env.CELLD_BIN;
const ESBUILD_DIR = process.env.ESBUILD_DIR ?? "";

async function celldDev(dir: string, port: number): Promise<ChildProcess> {
  const p = spawn(CELLD!, ["dev", ".", "--port", String(port), "--logs"], {
    cwd: dir,
    env: { ...process.env, PATH: `${ESBUILD_DIR}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("ready"); i++)
    await new Promise((r) => setTimeout(r, 200));
  if (!log.includes("ready")) throw new Error(`celld dev did not start:\n${log.slice(-2500)}`);
  return p;
}
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => {
    p.once("exit", () => r());
    p.kill("SIGTERM");
  });
const bump = async (url: string) => {
  const text = await (await fetch(url)).text();
  try {
    return (JSON.parse(text) as { n: number }).n;
  } catch {
    throw new Error(`celld answered: ${text}`);
  }
};

describe.skipIf(!CELLD)(
  "P11c moving a Durable Object between celld and webrun-cells (one bucket)",
  () => {
    it("celld → webrun-cells → celld keeps the object's state", async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "migrate-")), "sql-counter");
      cpSync(resolve(__dirname, "../conformance/projects/sql-counter"), dir, { recursive: true });

      // 1. celld owns the cell.
      let celld = await celldDev(dir, 18_811);
      expect(await bump("http://127.0.0.1:18811/")).toBe(1);
      expect(await bump("http://127.0.0.1:18811/")).toBe(2);
      await stop(celld);

      // 2. webrun-cells takes it over from the same bucket once celld's node lease expires.
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const bucket = celldBucket(store, { node: "webrun-test", leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
      } as never);
      let n = 0;
      for (let i = 0; i < 40 && !n; i++) {
        const r = await runtime.fetch(new Request("http://w/"));
        if (r.ok) n = ((await r.json()) as { n: number }).n;
        else await new Promise((r2) => setTimeout(r2, 500)); // celld's lease is still live
      }
      expect(n).toBe(3);
      expect(
        ((await (await runtime.fetch(new Request("http://w/"))).json()) as { n: number }).n,
      ).toBe(4);
      await runtime.close(); // releases the cell
      await bucket.close();
      const keys = await store.list("cells/");
      process.stdout.write(`KEYS ${JSON.stringify(keys)}\n`);
      for (const k of keys.filter((k) => k.endsWith("own.json")))
        process.stdout.write(`OWN ${k} ${new TextDecoder().decode((await store.get(k))!.body)}\n`);
      store.close();
      expect(
        keys.some((k) => /\/ltx\/e\d+\/0000\/0000000000000001-0000000000000001\.ltx$/.test(k)),
      ).toBe(true);
      await new Promise((r) => setTimeout(r, 3_500)); // let webrun-test's node lease expire

      // 3. celld takes it back and continues from webrun-cells' writes.
      celld = await celldDev(dir, 18_812);
      try {
        expect(await bump("http://127.0.0.1:18812/")).toBe(5);
      } finally {
        await stop(celld);
      }
    }, 120_000);
  },
);
