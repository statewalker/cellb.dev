/**
 * The asynchronous side of the LTX VFS (src/adapters/ltx-vfs.ts): serves one cell's pages from
 * its LTX files on a FilesApi, and turns each commit into one LTX file there, in celld's layout
 * (`<dir>/<min>-<max>.ltx`, a snapshot 1..N first). Runs in any thread that is not the one
 * blocked on reads (the page, or a worker): `handle(msg)` answers into the shared buffer.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { ltxFileName } from "./ltx.js";
import { compactPagedCellTo, encodeLtxStream, openPagedCell, type PagedCell } from "./ltx-pages.js";

export function ltxPageServer(files: FilesApi, dir: string, sab: SharedArrayBuffer) {
  const ctl = new Int32Array(sab, 0, 2);
  const payload = new Uint8Array(sab, 8);
  let cell: PagedCell | undefined;
  const list = async () => {
    const out: string[] = [];
    for await (const e of files.list(dir))
      if (e.kind === "file" && e.name.endsWith(".ltx")) out.push(e.path);
    return out;
  };
  const reopen = async () => {
    const paths = await list();
    cell = paths.length ? await openPagedCell(files, paths) : undefined;
  };
  const answer = (bytes: Uint8Array, state = 1) => {
    payload.set(bytes);
    ctl[1] = bytes.length;
    Atomics.store(ctl, 0, state);
    Atomics.notify(ctl, 0);
  };
  const enc = new TextEncoder();
  let queue = Promise.resolve();
  const ready = reopen();
  return {
    ready,
    /** Answers one request of the VFS (in order). */
    handle(msg: {
      op: string;
      pgno?: number;
      pageSize?: number;
      pageCount?: number;
      pages?: [number, Uint8Array][];
    }) {
      queue = queue.then(async () => {
        await ready;
        try {
          if (msg.op === "meta")
            return answer(
              enc.encode(
                JSON.stringify({ pageSize: cell?.pageSize ?? 0, pageCount: cell?.pageCount ?? 0 }),
              ),
            );
          if (msg.op === "read")
            return answer(await (cell as PagedCell).readPage(msg.pgno as number));
          if (msg.op === "commit") {
            const txid = (cell?.maxTXID ?? 0n) + 1n;
            async function* pages() {
              yield* msg.pages as [number, Uint8Array][];
            }
            await files.write(
              `${dir}/${ltxFileName(txid, txid)}`,
              encodeLtxStream(
                {
                  pageSize: msg.pageSize as number,
                  commit: msg.pageCount as number,
                  minTXID: txid,
                  maxTXID: txid,
                  timestamp: Date.now(),
                  preApplyChecksum: 0n,
                },
                pages(),
              ),
            );
            await reopen();
            return answer(new Uint8Array());
          }
          throw new Error(`unknown op ${msg.op}`);
        } catch (err) {
          answer(enc.encode(String((err as Error)?.message ?? err)), 2);
        }
      });
    },
    /** Folds the cell's files into one snapshot, streamed, then removes the files it replaces. */
    async compact() {
      await (queue = queue.then(async () => {
        await ready;
        if (!cell || cell.files.length < 2) return;
        const old = cell.files.map((f) => f.path);
        const tmp = `${dir}/${ltxFileName(1n, cell.maxTXID)}.tmp`;
        await compactPagedCellTo(cell, files, tmp);
        for (const p of old) await files.remove(p);
        await files.move?.(tmp, `${dir}/${ltxFileName(1n, cell.maxTXID)}`);
        await reopen();
      }));
      return cell?.files.length ?? 0;
    },
    get files() {
      return cell?.files.map((f) => f.path) ?? [];
    },
  };
}
