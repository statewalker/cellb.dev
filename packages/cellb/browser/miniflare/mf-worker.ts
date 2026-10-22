/// <reference lib="webworker" />
// P08 in the browser: Miniflare's KV and D1 simulators (unchanged) + workerd's D1 client,
// running in a Dedicated Worker on OPFS (sahpool SQLite + OPFS FilesApi blob store).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import { createCellRuntime } from "../../src/index.js";
import { filesApiBlobService } from "../../src/miniflare-compat/blob-service.js";
import { kvNamespaceBinding } from "../../src/miniflare-compat/kv-binding.js";
import { simulatorFetcher } from "../../src/miniflare-compat/simulator-fetcher.js";
import { D1DatabaseObject } from "../../src/miniflare-compat/vendored.js";
// @ts-expect-error — generated bundles (scripts/vendor-miniflare.mjs)
import makeD1Binding from "../../vendor/miniflare/d1-api.js";
// @ts-expect-error — generated bundle
import { KVNamespaceObject } from "../../vendor/miniflare/kv-namespace.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = (async () => {
  const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr: console.error });
  const openSql = await sahpoolOpener(sqlite3, { name: "webrun-cells-miniflare" });
  const root = await navigator.storage.getDirectory();
  const files = new BrowserFilesApi({
    rootHandle: await root.getDirectoryHandle("miniflare-blobs", { create: true }),
  });
  const rt = createCellRuntime({
    worker: { KVNamespaceObject, D1DatabaseObject, default: {} },
    durableObjects: {
      KV_OBJECTS: { className: "KVNamespaceObject" },
      D1_OBJECTS: { className: "D1DatabaseObject" },
    },
    vars: { MINIFLARE_BLOBS: filesApiBlobService(files) },
    openSql,
  });
  return {
    kv: kvNamespaceBinding(rt.env.KV_OBJECTS as never, "kv-browser"),
    db: makeD1Binding({ fetcher: simulatorFetcher(rt.env.D1_OBJECTS as never, "d1-browser") }),
  };
})();

scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    const { kv, db } = await ready;
    const m = e.data;
    if (m.op === "kv-put") await kv.put(m.key, m.value, { metadata: m.metadata });
    if (m.op === "kv-get") return reply({ ok: true, v: await kv.getWithMetadata(m.key) });
    if (m.op === "kv-list")
      return reply({
        ok: true,
        v: (await kv.list({ prefix: m.prefix })).keys.map((k: any) => k.name),
      });
    if (m.op === "d1") {
      await db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
      await db.prepare("INSERT INTO notes (body) VALUES (?)").bind(m.body).run();
      return reply({
        ok: true,
        v: (await db.prepare("SELECT body FROM notes ORDER BY id").raw()).flat(),
      });
    }
    reply({ ok: true });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
