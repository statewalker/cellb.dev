/**
 * The asynchronous side of the LTX VFS (src/adapters/ltx-vfs.ts): serves cells' pages from their
 * LTX files on a FilesApi and turns each commit into one LTX file there, in celld's layout
 * (`cells/<cell>/ltx/e1/0000/<min>-<max>.ltx`, a snapshot 1..N first). Runs in any thread that
 * is not one blocked on reads (a worker of its own, or a page): `handle(msg)` answers into the
 * shared buffer. A cell whose files pass `compactAfter` is folded into one snapshot (streamed).
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { scopeOf } from "../core/celld-schema.js";
import { ltxFileName } from "./ltx.js";
import { compactPagedCellTo, encodeLtxStream, openPagedCell, type PagedCell } from "./ltx-pages.js";

export interface LtxStoreMessage {
  op: "meta" | "read" | "readRun" | "commit" | "stats";
  cell: string;
  pgno?: number;
  count?: number;
  pageSize?: number;
  pageCount?: number;
  pages?: [number, Uint8Array][];
}

export function ltxCellStore(
  files: FilesApi,
  sab: SharedArrayBuffer,
  opts: { root?: string; compactAfter?: number } = {},
) {
  const ctl = new Int32Array(sab, 0, 2);
  const payload = new Uint8Array(sab, 8);
  const root = (opts.root ?? "").replace(/\/$/, "");
  const compactAfter = opts.compactAfter ?? 64;
  // celld's cell directory: `<Class>:<idHex>` (scopeOf), as the LTX log and celld name it.
  const dirOf = (cell: string) =>
    `${root}/cells/${scopeOf(cell).replace(/[\\/]/g, "_")}/ltx/e1/0000`;
  const cells = new Map<string, PagedCell | undefined>();
  /** Where the store's time goes (ms), for traces. */
  const stats = {
    commits: 0,
    writeMs: 0,
    appendMs: 0,
    compactions: 0,
    compactMs: 0,
    reads: 0,
    readMs: 0,
  };
  const list = async (dir: string) => {
    const out: string[] = [];
    if (!(await files.exists(dir))) return out;
    for await (const e of files.list(dir))
      if (e.kind === "file" && e.name.endsWith(".ltx")) out.push(e.path);
    return out;
  };
  const cellOf = async (cell: string) => {
    if (!cells.has(cell)) {
      const paths = await list(dirOf(cell));
      cells.set(cell, paths.length ? await openPagedCell(files, paths) : undefined);
    }
    return cells.get(cell);
  };
  const answer = (bytes: Uint8Array, state = 1) => {
    payload.set(bytes);
    ctl[1] = bytes.length;
    Atomics.store(ctl, 0, state);
    Atomics.notify(ctl, 0);
  };
  const enc = new TextEncoder();
  let queue = Promise.resolve();

  const compact = async (cell: string) => {
    const c = await cellOf(cell);
    if (!c || c.files.length < 2) return c?.files.length ?? 0;
    const dir = dirOf(cell);
    const final = `${dir}/${ltxFileName(1n, c.maxTXID)}`;
    const tmp = `${final}.tmp`;
    await compactPagedCellTo(c, files, tmp); // page by page: memory stays at one page + index
    for (const f of c.files) await files.remove(f.path);
    await files.move(tmp, final);
    cells.delete(cell);
    return (await cellOf(cell))?.files.length ?? 0;
  };

  return {
    /** Answers one request of a VFS (requests are served in order). */
    handle(msg: LtxStoreMessage) {
      queue = queue.then(async () => {
        try {
          const c = await cellOf(msg.cell);
          if (msg.op === "meta")
            return answer(
              enc.encode(
                JSON.stringify({ pageSize: c?.pageSize ?? 0, pageCount: c?.pageCount ?? 0 }),
              ),
            );
          if (msg.op === "read") return answer(await (c as PagedCell).readPage(msg.pgno as number));
          if (msg.op === "readRun") {
            stats.reads++;
            const tr = performance.now();
            try {
              const run = await (c as PagedCell).readRun(msg.pgno as number, msg.count as number);
              const size = (c as PagedCell).pageSize;
              const out = new Uint8Array(run.size * size);
              [...run.keys()]
                .sort((a, b) => a - b)
                .forEach((p, i) => out.set(run.get(p) as Uint8Array, i * size));
              return answer(out);
            } finally {
              stats.readMs += performance.now() - tr;
            }
          }
          if (msg.op === "stats") return answer(enc.encode(JSON.stringify(stats)));
          if (msg.op === "commit") {
            const t0 = performance.now();
            const txid = (c?.maxTXID ?? 0n) + 1n;
            const path = `${dirOf(msg.cell)}/${ltxFileName(txid, txid)}`;
            const pages = msg.pages as [number, Uint8Array][];
            const written = { index: new Map<number, [number, number]>() };
            const header = {
              pageSize: msg.pageSize as number,
              commit: msg.pageCount as number,
              minTXID: txid,
              maxTXID: txid,
              timestamp: Date.now(),
              preApplyChecksum: 0n,
            };
            await files.write(
              path,
              encodeLtxStream(
                header,
                (async function* () {
                  yield* pages;
                })(),
                0n,
                written,
              ),
            );
            const t1 = performance.now();
            // The first commit is the snapshot; later ones extend the overlay by one file.
            if (c) await c.append(path, { header: { flags: 2, ...header }, index: written.index });
            else cells.delete(msg.cell);
            answer(new Uint8Array());
            stats.commits++;
            stats.writeMs += t1 - t0;
            stats.appendMs += performance.now() - t1;
            // Past the threshold, fold the cell into one snapshot (after answering the commit).
            if (c && c.files.length >= compactAfter) {
              const t2 = performance.now();
              await compact(msg.cell);
              stats.compactions++;
              stats.compactMs += performance.now() - t2;
            }
            return;
          }
          throw new Error(`unknown op ${msg.op}`);
        } catch (err) {
          answer(enc.encode(String((err as Error)?.message ?? err)), 2);
        }
      });
    },
    /** Folds a cell's files into one snapshot; answers its file count after. */
    compact: (cell: string) =>
      (queue = queue.then(() => compact(cell).then(() => {}))).then(
        async () => (await cellOf(cell))?.files.length ?? 0,
      ),
    stats,
    /** The paths of a cell's current files. */
    files: async (cell: string) => (await cellOf(cell))?.files.map((f) => f.path) ?? [],
  };
}

/** One cell at `dir` (the earlier single-cell form): messages may omit `cell`. */
export function ltxPageServer(files: FilesApi, dir: string, sab: SharedArrayBuffer) {
  const m = /^(.*)\/cells\/([^/]+)\/ltx\/e1\/0000$/.exec(dir);
  const root = m ? m[1] : dir;
  const name = m ? m[2] : "cell";
  const store = ltxCellStore(files, sab, { root, compactAfter: Number.POSITIVE_INFINITY });
  let count = 0;
  const refresh = async () => {
    count = (await store.files(name)).length;
  };
  return {
    ready: refresh(),
    handle: (msg: Omit<LtxStoreMessage, "cell"> & { cell?: string }) => {
      store.handle({ ...msg, cell: name } as LtxStoreMessage);
      void refresh();
    },
    compact: async () => {
      const n = await store.compact(name);
      count = n;
      return n;
    },
    get files() {
      return Array.from({ length: count });
    },
    stats: store.stats,
    /** The cell's file count, after the requests sent so far. */
    fileCount: async () => (await store.files(name)).length,
  };
}
