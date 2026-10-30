/// <reference lib="webworker" />
// The store in a worker of its own: a cell's LTX files on OPFS, served to VFS workers that
// connect with a MessagePort (their reads and commits), answered into the shared buffer.
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { ltxPageServer } from "../../../packages/cellb/src/ltx/ltx-page-server.ts";
import {
  opfsSyncFiles,
  opfsSyncWriteStats,
} from "../../../packages/cellb/src/ltx/opfs-sync-files.ts";

let server: ReturnType<typeof ltxPageServer> | undefined;
self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.op === "init") {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(m.root, { create: true });
    // `sync`: OPFS synchronous handles (this worker owns the directory); default: the async API.
    const files = m.sync ? opfsSyncFiles(dir) : new BrowserFilesApi({ rootHandle: dir });
    server = ltxPageServer(files, m.dir, m.sab);
    await server.ready;
    postMessage({ op: "ready" });
  } else if (m.op === "connect") {
    (m.port as MessagePort).onmessage = (ev) => server?.handle(ev.data);
  } else if (m.op === "compact") {
    postMessage({ op: "compacted", files: await server?.compact() });
  } else if (m.op === "stats") {
    postMessage({ op: "stats", stats: { ...server?.stats, opfs: opfsSyncWriteStats } });
  } else if (m.op === "files") {
    postMessage({ op: "files", files: (await server?.fileCount()) ?? 0 });
  }
};
