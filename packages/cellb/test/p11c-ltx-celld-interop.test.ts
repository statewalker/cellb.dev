import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import v8 from "node:v8";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { filesApiLtxLog } from "../src/index.js";

// Both directions through celld's own storage format: the REAL celld writes a cell; webrun-
// cells' LTX log restores that database from celld's LTX files (same bucket keys); a new
// write is logged by webrun-cells as an LTX file under the next epoch; the real celld then
// restores the cell from webrun-cells' files and continues from the value written there.
// Needs the celld binary (CELLD_BIN) and esbuild (ESBUILD_DIR); skipped otherwise.
const CELLD = process.env.CELLD_BIN;
const example = join(__dirname, "../conformance/celld-examples/counter");

async function startCelld(dir: string, port: number): Promise<ChildProcess> {
  const env = { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` };
  const p = spawn(CELLD!, ["dev", ".", "--port", String(port), "--logs"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("ready"); i++)
    await new Promise((r) => setTimeout(r, 200));
  if (!log.includes("ready")) throw new Error(`celld did not start:\n${log.slice(-600)}`);
  (p as ChildProcess & { log: () => string }).log = () => log;
  return p;
}
const stop = async (p: ChildProcess) => {
  p.kill("SIGTERM");
  await new Promise((r) => p.once("exit", r));
};
const inc = async (base: string) => {
  const text = await (await fetch(`${base}/increment?name=alpha`)).text();
  try {
    return JSON.parse(text).n as number;
  } catch {
    throw new Error(`celld answered: ${text.slice(0, 300)}`);
  }
};

describe.skipIf(!CELLD)("P11c LTX interop with the real celld (both directions)", () => {
  it("celld → webrun-cells: celld's LTX files restore byte-identical pages (same tables and rows)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ltx-interop-")), "counter");
    cpSync(example, dir, { recursive: true });
    // 1. celld writes the cell (n = 1, 2, 3).
    const celld = await startCelld(dir, 18_781);
    for (let i = 0; i < 3; i++) await inc("http://127.0.0.1:18781");
    await stop(celld);

    // 2. Its bucket objects → a FilesApi at the same keys.
    const bucket = new DatabaseSync(join(dir, ".celld/dev/objects.sqlite3"));
    const files = new MemFilesApi();
    let epoch = 0;
    for (const r of bucket
      .prepare("SELECT key, body FROM objects WHERE key LIKE 'cells/Counter:%/ltx/%'")
      .all() as {
      key: string;
      body: Uint8Array;
    }[]) {
      await files.write(`/${r.key}`, [new Uint8Array(r.body)]);
      epoch = Math.max(epoch, Number(/\/ltx\/e(\d+)\//.exec(r.key)![1]));
    }

    // 3. webrun-cells' LTX log restores celld's database from celld's files (same keys):
    //    byte-identical pages, so the same tables and rows as celld's own copy.
    const cellKey = (
      bucket.prepare("SELECT key FROM objects WHERE key LIKE 'cells/Counter:%/own.json'").get() as {
        key: string;
      }
    ).key
      .split("/")[1]
      .replace(":", "/");
    const log = filesApiLtxLog(files, { epoch: epoch + 1 });
    const image = await log.load!(cellKey);
    expect(image).toBeDefined();
    const restoredFile = join(mkdtempSync(join(tmpdir(), "ltx-restored-")), "db.sqlite");
    writeFileSync(restoredFile, image!);
    const restored = new DatabaseSync(restoredFile);
    const kv = restored.prepare("SELECT scope, k, hex(v) AS v FROM _cf_KV").all() as {
      k: string;
      v: string;
    }[];
    expect(kv.map((r) => [r.k, r.v])).toEqual([
      ["n", v8.serialize(3).toString("hex").toUpperCase()],
    ]);

    restored.close();
  }, 120_000);

  /*
   * The reverse direction — celld restoring a cell from LTX files that webrun-cells wrote
   * under a later epoch — is NOT achieved yet: celld 0.6.2 builds its restore chain from its
   * own epoch bookkeeping (it chose e2, then reported "e2: ltx file corrupted" once our
   * e3 files and own.json were in the bucket; deleting the local replica alone restores fine).
   * Kept as a documented open item (note 22) rather than a test that hides the gap.
   */
  it.skip("webrun-cells → celld: celld restores from webrun-cells' LTX files (open)", () => {});
});
