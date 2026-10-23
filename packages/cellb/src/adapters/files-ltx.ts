import type { FilesApi } from "@statewalker/webrun-files";
import { ltxLog } from "../bucket/ltx-log.js";
import { filesApiObjectStore } from "../bucket/object-store.js";

/**
 * The LTX log on a webrun-files FilesApi (OPFS in browsers, a directory on Node), without
 * ownership: the same writer as celldBucket (src/bucket/ltx-log.ts), on the FilesApi as an
 * object store. Keys are celld's: `<dir>/<Class>:<id>/ltx/e<epoch>/0000/<min>-<max>.ltx`
 * (`dir` defaults to "/cells"), so the files read the same in celld.
 */
export interface LtxLogOptions {
  /** Where the `cells/` keys live; defaults to "/cells". */
  dir?: string;
  /** The epoch the files are written in (no ownership); 0 by default. */
  epoch?: number;
  intervalMs?: number;
  onError?: (cellKey: string, error: unknown) => void;
}

export function filesApiLtxLog(files: FilesApi, opts: LtxLogOptions = {}) {
  const dir = (opts.dir ?? "/cells").replace(/\/$/, "");
  const root = dir.endsWith("/cells") ? dir.slice(0, -"/cells".length) : dir;
  const log = ltxLog(filesApiObjectStore(files, root), {
    defaultEpoch: opts.epoch ?? 0,
    compact: true,
  });
  return Object.assign(log, { intervalMs: opts.intervalMs, onError: opts.onError });
}
