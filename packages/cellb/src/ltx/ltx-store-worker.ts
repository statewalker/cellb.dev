/// <reference lib="webworker" />
/**
 * The LTX store as a worker of its own (spawned by a shard worker that runs cells on the LTX
 * VFS): cells' LTX files in an OPFS directory, in celld's layout. The shard connects with
 * `{ op: "init", sab, dir, compactAfter }`, then sends the VFS's requests; answers go into
 * the shared buffer.
 */
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { ltxCellStore } from "./ltx-page-server.js";
import { opfsSyncFiles } from "./opfs-sync-files.js";

let store: ReturnType<typeof ltxCellStore> | undefined;
let ready: Promise<void> | undefined;
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.op === "init") {
    ready = (async () => {
      // The cells' FilesApi, by name (an instance cannot cross to this worker): "opfs-sync"
      // (default: synchronous handles; each file written under a temporary name and moved into
      // place, so a file being written is never read), "opfs" (OPFS's asynchronous API),
      // "memory" (nothing kept).
      const files =
        m.files === "memory"
          ? new MemFilesApi()
          : await (async () => {
              const root = await navigator.storage.getDirectory();
              const dir = await root.getDirectoryHandle(m.dir, { create: true });
              return m.files === "opfs"
                ? new BrowserFilesApi({ rootHandle: dir })
                : opfsSyncFiles(dir);
            })();
      store = ltxCellStore(files, m.sab, { compactAfter: m.compactAfter, lockScope: m.dir });
      postMessage({ op: "ready" });
    })();
    return;
  }
  void ready?.then(() => store?.handle(m));
};
