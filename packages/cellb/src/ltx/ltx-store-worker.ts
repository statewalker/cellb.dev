/// <reference lib="webworker" />
/**
 * The LTX store as a worker of its own (spawned by a shard worker that runs cells on the LTX
 * VFS): cells' LTX files on a FilesApi, in celld's layout. The shard connects with
 * `{ op: "init", sab, dir, compactAfter, files, … }` (an `LtxStoreInit`), then sends the VFS's
 * requests; answers go into the shared buffer.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { rpcFilesClient } from "./files-rpc.js";
import { type LtxStoreInit, ltxCellStore } from "./ltx-page-server.js";
import { opfsSyncFiles } from "./opfs-sync-files.js";

async function open(
  m: LtxStoreInit,
): Promise<{ files: FilesApi; room?: () => Promise<number | undefined> }> {
  const f = m.files ?? "opfs-sync";
  if (f === "memory") return { files: new MemFilesApi() };
  if (typeof f === "object" && "port" in f)
    // Free space of a FilesApi elsewhere is unknown here: compactions are not held back.
    return { files: rpcFilesClient(f.port), room: async () => undefined };
  if (typeof f === "object" && "module" in f) {
    const mod = (await import(/* @vite-ignore */ f.module)) as {
      default?: (args: unknown) => FilesApi | Promise<FilesApi>;
      createFilesApi?: (args: unknown) => FilesApi | Promise<FilesApi>;
      room?: (args: unknown) => Promise<number | undefined>;
    };
    const create = mod.createFilesApi ?? mod.default;
    if (typeof create !== "function")
      throw new Error(`ltx store: ${f.module} exports no createFilesApi (or default) function`);
    const room = mod.room;
    return {
      files: await create(f.args),
      room: room ? () => room(f.args) : async () => undefined,
    };
  }
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(m.dir, { create: true });
  return { files: f === "opfs" ? new BrowserFilesApi({ rootHandle: dir }) : opfsSyncFiles(dir) };
}

let store: ReturnType<typeof ltxCellStore> | undefined;
let ready: Promise<void> | undefined;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.op === "init") {
    ready = (async () => {
      try {
        const { files, room } = await open(m as LtxStoreInit);
        store = ltxCellStore(files, m.sab, {
          compactAfter: m.compactAfter,
          lockScope: m.dir,
          room,
        });
        postMessage({ op: "ready" });
      } catch (err) {
        postMessage({ op: "failed", error: String((err as Error)?.message ?? err) });
      }
    })();
    return;
  }
  void ready?.then(() => store?.handle(m));
};
