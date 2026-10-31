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
import {
  compactPagedCellTo,
  encodeLtxStream,
  LtxShortReadError,
  openPagedCell,
  type PagedCell,
} from "./ltx-pages.js";

/** Bytes of page data a cell's files hold (what a compaction may write, at most). */
const pageBytes = (c: PagedCell) =>
  c.files.reduce((n, f) => n + [...f.index.values()].reduce((m, [, size]) => m + size, 0), 0);

/** Free bytes in this origin's storage, or undefined where the estimate is not available. */
async function room(): Promise<number | undefined> {
  const storage = (globalThis.navigator as { storage?: StorageManager } | undefined)?.storage;
  if (!storage?.estimate) return undefined;
  const { usage = 0, quota } = await storage.estimate();
  return quota === undefined ? undefined : quota - usage;
}

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
  opts: {
    root?: string;
    compactAfter?: number;
    autoCompact?: boolean;
    /**
     * What the files are (the OPFS directory's name, say): part of each cell's Web Lock, so the
     * stores of two directories (two projects in one tab) do not take each other's locks.
     */
    lockScope?: string;
  } = {},
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
  const list = async (dir: string, cleanUp = false) => {
    const out: string[] = [];
    if (!(await files.exists(dir))) return out;
    for await (const e of files.list(dir)) {
      if (e.kind !== "file") continue;
      if (e.name.endsWith(".ltx")) out.push(e.path);
      // On this store's first open of the cell: a compaction or a write that did not finish
      // (a closed tab, a full disk), its space back.
      else if (cleanUp && /\.ltx\.(tmp|part-\w+)$/.test(e.name))
        await files.remove(e.path).catch(() => false);
    }
    return out;
  };
  /**
   * One writer per cell in the origin: the store holds a Web Lock per cell directory while the
   * cell is open, so another tab's store (or worker) cannot write the same cell meanwhile; it
   * fails instead. (Across machines, celld's epochs and ownership records do this.)
   */
  const owned = new Set<string>();
  const own = async (dir: string) => {
    const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
    if (!locks || owned.has(dir)) return;
    // Waits a while for it: on a reload, the previous page's store holds it until its worker
    // goes, a moment later (failing at once broke the cell's Durable Object on every reload).
    const got = await new Promise<boolean>((resolve) => {
      void locks
        .request(
          `cellb-ltx:${opts.lockScope ?? ""}:${dir}`,
          { signal: AbortSignal.timeout(20_000) },
          () => {
            resolve(true);
            return new Promise<void>(() => {}); // held while this store lives
          },
        )
        .catch(() => resolve(false));
    });
    if (!got) throw new Error(`ltx: cell ${dir} is open in another tab or worker (waited 20 s)`);
    owned.add(dir);
  };
  const cellOf = async (cell: string) => {
    if (!cells.has(cell)) {
      const dir = dirOf(cell);
      const first = !owned.has(dir);
      await own(dir);
      const paths = await list(dir, first);
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
  /** The request being served and its stage: a watchdog names the one that does not end. */
  const current = { op: "", cell: "", stage: "", since: 0 };
  const stage = (s: string) => {
    current.stage = s;
  };
  const watchdog = setInterval(() => {
    if (current.op && performance.now() - current.since > 10_000)
      console.warn(
        `cellb ltx-store: ${current.op} of ${current.cell} at "${current.stage}" for ${Math.round((performance.now() - current.since) / 1000)} s`,
      );
  }, 10_000);
  (watchdog as { unref?: () => void }).unref?.();

  /**
   * Folds a cell's files into one snapshot WITHOUT holding up its requests: the snapshot is
   * written from a frozen view of the files as they are now (later commits add files after
   * them), then, between two requests, the files it replaces are removed and the cell reopened
   * (the snapshot plus the files written meanwhile). One compaction per cell at a time.
   */
  const compacting = new Map<string, Promise<number>>();
  const compact = (cell: string): Promise<number> => {
    const running = compacting.get(cell);
    if (running) return running;
    const job = (async () => {
      const c = await cellOf(cell);
      if (!c || c.files.length < 2) return c?.files.length ?? 0;
      const dir = dirOf(cell);
      const replaced = c.files.map((f) => f.path);
      // The new snapshot exists beside the files it replaces until the swap: without the room
      // for it, the compaction would only fill the disk (and fail the commits after it).
      const needed = pageBytes(c);
      const free = await room();
      if (free !== undefined && free < needed * 1.25 + (64 << 20)) {
        console.warn(
          `cellb ltx-store: ${cell}: no compaction, ${Math.round(free / 1e6)} MB free for a snapshot of up to ${Math.round(needed / 1e6)} MB`,
        );
        return c.files.length;
      }
      const frozen = await openPagedCell(files, replaced);
      const final = `${dir}/${ltxFileName(1n, frozen.maxTXID)}`;
      const tmp = `${final}.tmp`;
      try {
        await compactPagedCellTo(frozen, files, tmp); // page runs: memory stays at a run + index
      } catch (err) {
        await files.remove(tmp).catch(() => false);
        throw err;
      }
      await new Promise<void>((resolve, reject) => {
        queue = queue.then(async () => {
          try {
            for (const p of replaced) await files.remove(p);
            await files.move(tmp, final);
            cells.delete(cell);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      return (await cellOf(cell))?.files.length ?? 0;
    })().finally(() => compacting.delete(cell));
    compacting.set(cell, job);
    return job;
  };

  /**
   * When to compact: past `compactAfter` files, or once the files after the snapshot hold more
   * bytes than half of it (a large cell is not rewritten for a few small commits).
   */
  const deltaBytes = new Map<string, number>();
  const wantsCompaction = (cell: string, c: PagedCell) => {
    if (opts.autoCompact === false) return false;
    if (c.files.length >= compactAfter) return true;
    const snapshot = c.files[0];
    const snapshotBytes = [...snapshot.index.values()].reduce((n, [, size]) => n + size, 0);
    return c.files.length > 1 && (deltaBytes.get(cell) ?? 0) > Math.max(1 << 20, snapshotBytes / 2);
  };

  return {
    /** Answers one request of a VFS (requests are served in order). */
    handle(msg: LtxStoreMessage) {
      queue = queue.then(async () => {
        Object.assign(current, {
          op: msg.op,
          cell: msg.cell,
          stage: "open",
          since: performance.now(),
        });
        try {
          const c = await cellOf(msg.cell);
          stage("serve");
          if (msg.op === "meta")
            return answer(
              enc.encode(
                JSON.stringify({ pageSize: c?.pageSize ?? 0, pageCount: c?.pageCount ?? 0 }),
              ),
            );
          // A read of a file that changed under the cell's view: reopen the cell, read again.
          const retried = async <T>(read: (c: PagedCell) => Promise<T>): Promise<T> => {
            try {
              return await read(c as PagedCell);
            } catch (err) {
              if (!(err instanceof LtxShortReadError)) throw err;
              console.warn(`cellb ltx-store: ${msg.cell}: ${err.message}; reopening the cell`);
              cells.delete(msg.cell);
              stage("reopen");
              return read((await cellOf(msg.cell)) as PagedCell);
            }
          };
          if (msg.op === "read")
            return answer(await retried((c) => c.readPage(msg.pgno as number)));
          if (msg.op === "readRun") {
            stats.reads++;
            const tr = performance.now();
            try {
              const run = await retried((c) => c.readRun(msg.pgno as number, msg.count as number));
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
            stage(`write ${path}`);
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
            stage("append");
            // The first commit is the snapshot; later ones extend the overlay by one file.
            if (c) await c.append(path, { header: { flags: 2, ...header }, index: written.index });
            else cells.delete(msg.cell);
            answer(new Uint8Array());
            stats.commits++;
            stats.writeMs += t1 - t0;
            stats.appendMs += performance.now() - t1;
            // Past the threshold, fold the cell into one snapshot (after answering the commit).
            deltaBytes.set(
              msg.cell,
              (deltaBytes.get(msg.cell) ?? 0) +
                [...written.index.values()].reduce((n, [, size]) => n + size, 0),
            );
            if (c && wantsCompaction(msg.cell, c) && !compacting.has(msg.cell)) {
              const t2 = performance.now();
              deltaBytes.set(msg.cell, 0);
              void compact(msg.cell).then(
                () => {
                  stats.compactMs += performance.now() - t2;
                },
                (err) => console.warn(`cellb ltx-store: compaction of ${msg.cell} failed:`, err),
              );
              stats.compactions++;
            }
            return;
          }
          throw new Error(`unknown op ${msg.op}`);
        } catch (err) {
          console.warn(
            `cellb ltx-store: ${msg.op} of ${msg.cell} failed at "${current.stage}":`,
            err,
          );
          answer(enc.encode(String((err as Error)?.message ?? err)), 2);
        } finally {
          current.op = "";
        }
      });
    },
    /** Folds a cell's files into one snapshot; answers its file count after. */
    /** Folds a cell's files into one snapshot (not through the request queue: it takes its
     * own turn there to swap the files); answers the cell's file count after. */
    compact: (cell: string) => compact(cell),
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
  const store = ltxCellStore(files, sab, { root, autoCompact: false });
  let count = 0;
  const refresh = async () => {
    count = (await store.files(name)).length;
  };
  return {
    // A cell another store owns fails its requests (the VFS gets the error), not the start.
    ready: refresh().catch(() => {}),
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
