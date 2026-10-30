/// <reference lib="webworker" />
/**
 * The LTX store as a worker of its own (spawned by a shard worker that runs cells on the LTX
 * VFS): cells' LTX files in an OPFS directory, in celld's layout. The shard connects with
 * `{ op: "init", sab, dir, compactAfter }`, then sends the VFS's requests; answers go into
 * the shared buffer.
 */
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { ltxCellStore } from "./ltx-page-server.js";

let store: ReturnType<typeof ltxCellStore> | undefined;
let ready: Promise<void> | undefined;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.op === "init") {
    ready = (async () => {
      const root = await navigator.storage.getDirectory();
      const files = new BrowserFilesApi({
        rootHandle: await root.getDirectoryHandle(m.dir, { create: true }),
      });
      store = ltxCellStore(files, m.sab, { compactAfter: m.compactAfter });
    })();
    return;
  }
  void ready?.then(() => store?.handle(m));
};
