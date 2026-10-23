import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import v8 from "node:v8";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { filesApiLtxLog } from "../src/index.js";
import { loadNodeProject } from "../src/project/node-project.js";

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

  it("webrun-cells → celld: celld restores a cell from LTX files webrun-cells wrote", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ltx-reverse-")), "counter");
    cpSync(example, dir, { recursive: true });
    // celld creates the cell (n = 1..3), then stops.
    let celld = await startCelld(dir, 18_783);
    for (let i = 0; i < 3; i++) await inc("http://127.0.0.1:18783");
    await stop(celld);
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
    const cell = (
      bucket.prepare("SELECT key FROM objects WHERE key LIKE 'cells/Counter:%/own.json'").get() as {
        key: string;
      }
    ).key.split("/")[1];
    // webrun-cells' log takes over at the next epoch and commits n := 41 (V8-serialized, as celld stores it).
    const log = filesApiLtxLog(files, { epoch: epoch + 1 });
    const image = await log.load!(cell.replace(":", "/"));
    const f = join(mkdtempSync(join(tmpdir(), "ltx-edit-")), "db.sqlite");
    writeFileSync(f, image!);
    const db = new DatabaseSync(f);
    db.prepare("UPDATE _cf_KV SET v = ? WHERE k = 'n'").run(v8.serialize(41));
    db.close();
    await log.committed(cell.replace(":", "/"), {
      seq: 1,
      image: new Uint8Array(readFileSync(f)),
      epoch: epoch + 1,
    });
    // Its files go into celld's bucket; the ownership record names the new epoch; celld's
    // local replica is dropped so it must restore from the bucket.
    const put = bucket.prepare(
      "INSERT OR REPLACE INTO objects (key, body, etag, modified_ms, attributes) VALUES (?, ?, (SELECT next_etag FROM store_sequence), ?, '[]')",
    );
    const bump = bucket.prepare("UPDATE store_sequence SET next_etag = next_etag + 1");
    for await (const e of files.list(`/cells/${cell}/ltx/e${epoch + 1}`, { recursive: true })) {
      if (e.kind !== "file") continue;
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(e.path)) chunks.push(c);
      put.run(e.path.slice(1), Buffer.concat(chunks), Date.now());
      bump.run();
    }
    put.run(
      `cells/${cell}/own.json`,
      Buffer.from(JSON.stringify({ node: "webrun-cells", epoch: epoch + 1 })),
      Date.now(),
    );
    bump.run();
    bucket.close();
    rmSync(join(dir, ".celld/dev/runtime", cell), { recursive: true, force: true });
    celld = await startCelld(dir, 18_784);
    try {
      const n = await inc("http://127.0.0.1:18784").catch((e) => {
        throw new Error(`${e.message}\n--- celld log ---\n${(celld as any).log().slice(-2500)}`);
      });
      expect(n).toBe(42);
    } finally {
      await stop(celld);
    }
  }, 120_000);

  it("the same Counter cell continues across celld → webrun-cells → celld (the runtimes themselves)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ltx-runtime-")), "counter");
    cpSync(example, dir, { recursive: true });
    let celld = await startCelld(dir, 18_785);
    for (let i = 0; i < 3; i++) await inc("http://127.0.0.1:18785"); // n = 3 on celld
    await stop(celld);
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
    // webrun-cells runs the same project, restores the cell from celld's LTX files (same ids,
    // same tables, V8 values) and increments it, logging LTX under the next epoch.
    const log = filesApiLtxLog(files, { epoch: epoch + 1 });
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(mkdtempSync(join(tmpdir(), "ltx-cells-"))),
      files: new MemFilesApi(),
      durability: log,
      backup: log,
    });
    const res = await runtime.fetch(new Request("http://x/increment?name=alpha"));
    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(JSON.parse(body).n).toBe(4);
    await runtime.close();
    // Back to celld: its bucket gets webrun-cells' files and the epoch; it continues at 5.
    const put = bucket.prepare(
      "INSERT OR REPLACE INTO objects (key, body, etag, modified_ms, attributes) VALUES (?, ?, (SELECT next_etag FROM store_sequence), ?, '[]')",
    );
    const bump = bucket.prepare("UPDATE store_sequence SET next_etag = next_etag + 1");
    let cell = "";
    for await (const e of files.list("/cells", { recursive: true })) {
      if (e.kind !== "file" || !e.path.includes(`/ltx/e${epoch + 1}/`)) continue;
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(e.path)) chunks.push(c);
      put.run(e.path.slice(1), Buffer.concat(chunks), Date.now());
      bump.run();
      cell = e.path.split("/")[2];
    }
    put.run(
      `cells/${cell}/own.json`,
      Buffer.from(JSON.stringify({ node: "webrun-cells", epoch: epoch + 1 })),
      Date.now(),
    );
    bump.run();
    bucket.close();
    rmSync(join(dir, ".celld/dev/runtime", cell), { recursive: true, force: true });
    celld = await startCelld(dir, 18_786);
    try {
      const n = await inc("http://127.0.0.1:18786").catch((e) => {
        throw new Error(`${e.message}\n--- celld log ---\n${(celld as any).log().slice(-2500)}`);
      });
      expect(n).toBe(5);
    } finally {
      await stop(celld);
    }
  }, 120_000);

  // ---- stored values (V8 serialization) both ways, with the kv-values project ----
  const valuesProject = join(__dirname, "../conformance/projects/kv-values");
  const expectedRead = () =>
    JSON.parse(readFileSync(join(__dirname, "../conformance/golden/kv-values.json"), "utf8"))
      .transcript[1].body;
  const get = async (base: string, path: string) => (await fetch(`${base}${path}`)).json();

  it("values written by celld read identically in webrun-cells", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "values-a-")), "kv-values");
    cpSync(valuesProject, dir, { recursive: true });
    const celld = await startCelld(dir, 18_787);
    await get("http://127.0.0.1:18787", "/write");
    await stop(celld);
    const bucket = new DatabaseSync(join(dir, ".celld/dev/objects.sqlite3"));
    const files = new MemFilesApi();
    for (const r of bucket
      .prepare("SELECT key, body FROM objects WHERE key LIKE 'cells/Store:%/ltx/%'")
      .all() as {
      key: string;
      body: Uint8Array;
    }[])
      await files.write(`/${r.key}`, [new Uint8Array(r.body)]);
    bucket.close();
    const log = filesApiLtxLog(files, { epoch: 99 });
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(mkdtempSync(join(tmpdir(), "values-cells-"))),
      files: new MemFilesApi(),
      durability: log,
      backup: log,
    });
    const read = await (await runtime.fetch(new Request("http://x/read"))).json();
    expect(read).toEqual(expectedRead());
    await runtime.close();
  }, 120_000);

  it("values written by webrun-cells read identically in celld", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "values-b-")), "kv-values");
    cpSync(valuesProject, dir, { recursive: true });
    // celld starts once so its bucket exists (deploy), without touching the Store cell.
    let celld = await startCelld(dir, 18_788);
    await stop(celld);
    const files = new MemFilesApi();
    const log = filesApiLtxLog(files, { epoch: 1 });
    const { runtime } = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(mkdtempSync(join(tmpdir(), "values-cells-"))),
      files: new MemFilesApi(),
      durability: log,
      backup: log,
    });
    await runtime.fetch(new Request("http://x/write"));
    await runtime.close();
    const bucket = new DatabaseSync(join(dir, ".celld/dev/objects.sqlite3"));
    const put = bucket.prepare(
      "INSERT OR REPLACE INTO objects (key, body, etag, modified_ms, attributes) VALUES (?, ?, (SELECT next_etag FROM store_sequence), ?, '[]')",
    );
    const bump = bucket.prepare("UPDATE store_sequence SET next_etag = next_etag + 1");
    let cell = "";
    for await (const e of files.list("/cells", { recursive: true })) {
      if (e.kind !== "file") continue;
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(e.path)) chunks.push(c);
      put.run(e.path.slice(1), Buffer.concat(chunks), Date.now());
      bump.run();
      cell = e.path.split("/")[2];
    }
    put.run(
      `cells/${cell}/own.json`,
      Buffer.from(JSON.stringify({ node: "webrun-cells", epoch: 1 })),
      Date.now(),
    );
    bump.run();
    bucket.close();
    celld = await startCelld(dir, 18_789);
    try {
      expect(await get("http://127.0.0.1:18789", "/read")).toEqual(expectedRead());
    } finally {
      await stop(celld);
    }
  }, 120_000);
});
