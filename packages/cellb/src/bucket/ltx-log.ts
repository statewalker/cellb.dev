import { decodeLtx, encodeLtx, ltxFileName } from "../ltx/ltx.js";
import type { BackupInfo, CellBackup, CellDurability } from "../ports.js";
import { equal, pad16, pageSizeOf, scopeOf, toRollback } from "./celld-cells.js";
import type { ObjectStore } from "./object-store.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * THE LTX writer of webrun-cells, in celld's bucket layout, on any ObjectStore:
 *
 *   cells/<Class>:<idHex>/ltx/e<epoch>/<level>/<min>-<max>.ltx   LTX v3 (src/ltx)
 *   wake/entries/…, wake/retired/…                               celld's alarm wake index
 *
 * Each committed transaction becomes one LTX file in the cell's epoch — the first one of an
 * epoch a snapshot (TXID 1), then only the changed pages (from the SQLite WASM page hook, or a
 * diff of the image) — and the output gate waits for the PUT; a cell's commits are written
 * strictly in order. Restore: the newest epoch whose files form a chain from a snapshot.
 * `compact` makes save() replace an epoch's files with one snapshot file 1..N.
 *
 * Used by celldBucket (with celld's ownership protocol: begin()/forget() per acquisition) and by
 * filesApiLtxLog (a FilesApi, a fixed epoch).
 */
export interface LtxLogOptions {
  now?: () => number;
  /** Epoch used when a commit names none (no ownership). */
  defaultEpoch?: number;
  /** save() compacts an epoch into one snapshot file 1..N. */
  compact?: boolean;
}

const range = (key: string) => {
  const m = /\/ltx\/e(\d+)\/\d+\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(key);
  return m
    ? { epoch: Number(m[1]), min: BigInt(`0x${m[2]}`), max: BigInt(`0x${m[3]}`) }
    : undefined;
};

export function ltxLog(store: ObjectStore, o: LtxLogOptions = {}) {
  const now = o.now ?? (() => Date.now());
  // Per cell: the epoch it writes into, its last TXID and the pages last written.
  const cells = new Map<
    string,
    { epoch: number; txid: bigint; pages: Map<number, Uint8Array> | undefined }
  >();
  /** The highest TXID already written in a cell's epoch (0n: none). */
  const lastTxid = async (cellKey: string, epoch: number) => {
    let max = 0n;
    for (const key of await store.list(`cells/${scopeOf(cellKey)}/ltx/e${epoch}/`)) {
      const r = range(key);
      if (r && r.epoch === epoch && r.max > max) max = r.max;
    }
    return max;
  };

  // celld's wake index (logic/wake.rs, wake_format.rs): one immutable entry per alarm
  // installation, filed under the UTC minute it is due; a per-cell retirement certificate
  // marks older installations (and a cancelled one) as void.
  const hex16 = (n: number) => n.toString(16).padStart(16, "0");
  let wakeFormat: Promise<unknown> | undefined;
  const ensureWakeFormat = () =>
    (wakeFormat ??= store
      .put("wake/format.json", enc.encode(JSON.stringify({ format: 2 })), { ifNoneMatch: "*" })
      .catch(() => {}));

  // Commits of one cell are logged one after the other, so TXIDs and the page mirror advance
  // in commit order. (Without this, two quick commits both saw TXID 0 and raced to PUT the
  // same snapshot key — the older image could land last; seen in Chromium against celld.)
  const queues = new Map<string, Promise<void>>();
  const inOrder = (cellKey: string, run: () => Promise<void>): Promise<void> => {
    const next = (queues.get(cellKey) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(cellKey, next);
    next.then(
      () => queues.get(cellKey) === next && queues.delete(cellKey),
      () => queues.get(cellKey) === next && queues.delete(cellKey),
    );
    return next;
  };

  const durability: CellDurability &
    CellBackup & {
      logCommit: CellDurability["committed"];
    } = {
    committed(cellKey, info) {
      return inOrder(cellKey, () => durability.logCommit(cellKey, info));
    },
    capturePages: true,

    async publishWake(cellKey, w) {
      await ensureWakeFormat();
      const cell = scopeOf(cellKey);
      const identity = `${hex16(w.epoch)}-${hex16(w.sequence)}`;
      // 1. the new installation's entry (none for a cancelled or consumed alarm)
      if (w.at != null) {
        const minute = new Date(w.at).toISOString().slice(0, 16);
        await store.put(
          `wake/entries/${minute}/${cell}/${identity}`,
          enc.encode(JSON.stringify({ cell, due_ms: w.at, format: 2, identity })),
        );
      }
      // 2. the retirement certificate, once the replacement is published (celld's order):
      //    every older identity is void, and this one too when the alarm is gone.
      await store.put(
        `wake/retired/${cell}.json`,
        enc.encode(JSON.stringify({ format: 2, identity, at_ms: w.at })),
      );
      // 3. cleanup below the certificate (celld: only below a proved frontier, which this is)
      for (const k of await store.list("wake/entries/")) {
        const m = /\/([0-9a-f]{16}-[0-9a-f]{16})$/.exec(k);
        if (
          !m ||
          !k.includes(`/${cell}/`) ||
          k.slice(0, -m[0].length).endsWith(`/${cell}`) === false
        )
          continue;
        const id = m[1];
        if (id < identity || (id === identity && w.at == null))
          await store.delete?.(k).catch(() => {});
      }
    },

    async wakes() {
      const retired = new Map<string, { id: string; none: boolean }>();
      for (const k of await store.list("wake/retired/")) {
        const o = await store.get(k);
        if (!o) continue;
        const r = JSON.parse(dec.decode(o.body)) as { identity: string; at_ms: number | null };
        retired.set(k.slice("wake/retired/".length, -".json".length), {
          id: r.identity,
          none: r.at_ms == null,
        });
      }
      const out: { cellKey: string; className: string; at: number }[] = [];
      const latest = new Map<string, { id: string; at: number }>();
      for (const k of await store.list("wake/entries/")) {
        const m = /^wake\/entries\/[^/]+\/(.+)\/([0-9a-f]{16}-[0-9a-f]{16})$/.exec(k);
        if (!m) continue;
        const [, cell, id] = m;
        if (cell.includes("/")) continue; // facets wake through their root
        const r = retired.get(cell);
        if (r && (id < r.id || (id === r.id && r.none))) continue;
        const o = await store.get(k);
        if (!o) continue;
        const at = (JSON.parse(dec.decode(o.body)) as { due_ms: number }).due_ms;
        const prev = latest.get(cell);
        if (!prev || id > prev.id) latest.set(cell, { id, at });
      }
      for (const [cell, { at }] of latest) {
        const [className] = cell.split(":");
        out.push({ cellKey: cell.replace(":", "/"), className, at });
      }
      return out;
    },

    async logCommit(cellKey, info) {
      let cell = cells.get(cellKey);
      if (!cell) {
        // First commit of this cell in this process: continue the epoch's TXIDs if it already
        // has files (a restart without a new epoch), with a whole-database file.
        const epoch = info.epoch ?? o.defaultEpoch ?? 1;
        cell = { epoch, txid: await lastTxid(cellKey, epoch), pages: undefined };
        cells.set(cellKey, cell);
      }
      // The page hook (SQLite WASM) hands over exactly the changed pages: no image needed.
      if (info.pages && cell.pages) {
        if (!info.pages.pages.size) return;
        const txid = cell.txid + 1n;
        await store.put(
          `cells/${scopeOf(cellKey)}/ltx/e${cell.epoch}/0000/${ltxFileName(txid, txid)}`,
          encodeLtx({
            header: {
              pageSize: info.pages.pageSize,
              commit: info.pages.pageCount,
              minTXID: txid,
              maxTXID: txid,
              timestamp: now(),
              preApplyChecksum: 0n,
            },
            pages: info.pages.pages,
            postApplyChecksum: 0n,
          }),
        );
        cell.txid = txid;
        for (const [p, d] of info.pages.pages) cell.pages.set(p, d.slice());
        for (const p of [...cell.pages.keys()]) if (p > info.pages.pageCount) cell.pages.delete(p);
        return;
      }
      const image = typeof info.image === "function" ? await info.image() : info.image;
      if (!image) return;
      const pageSize = pageSizeOf(image);
      const commit = image.length / pageSize;
      const page = (p: number) => image.subarray((p - 1) * pageSize, p * pageSize);
      const changed = new Map<number, Uint8Array>();
      for (let p = 1; p <= commit; p++) {
        const prev = cell.pages?.get(p);
        const cur = page(p);
        if (!prev || !equal(prev, cur)) changed.set(p, cur.slice());
      }
      if (cell.pages && changed.size === 0 && cell.pages.size === commit) return;
      const txid = cell.txid + 1n;
      const pages = cell.pages
        ? changed
        : new Map([...Array(commit)].map((_, i) => [i + 1, page(i + 1).slice()]));
      const file = encodeLtx({
        header: {
          pageSize,
          commit,
          minTXID: txid,
          maxTXID: txid,
          timestamp: now(),
          preApplyChecksum: 0n,
        },
        pages,
        postApplyChecksum: 0n, // celld 0.6.2 leaves the rolling checksums at 0
      });
      await store.put(
        `cells/${scopeOf(cellKey)}/ltx/e${cell.epoch}/0000/${ltxFileName(txid, txid)}`,
        file,
      );
      cell.txid = txid;
      cell.pages ??= new Map();
      for (const [p, d] of pages) cell.pages.set(p, d);
      for (const p of [...cell.pages.keys()]) if (p > commit) cell.pages.delete(p);
    },

    async save(cellKey: string, image: Uint8Array, _info: BackupInfo) {
      // Every transaction is already in the bucket; compaction (opt-in) folds an epoch into one
      // snapshot file 1..N — celld reads it as any snapshot.
      if (!o.compact) return;
      await inOrder(cellKey, async () => {
        const cell = cells.get(cellKey);
        const epoch = cell?.epoch ?? o.defaultEpoch ?? 1;
        const txid = cell?.txid ?? (await lastTxid(cellKey, epoch));
        if (!txid) return;
        const pageSize = pageSizeOf(image);
        const commit = image.length / pageSize;
        const pages = new Map(
          [...Array(commit)].map((_, n) => [n + 1, image.slice(n * pageSize, (n + 1) * pageSize)]),
        );
        const prefix = `cells/${scopeOf(cellKey)}/ltx/e${epoch}/`;
        const before = await store.list(prefix);
        const snapshot = `${prefix}0000/${ltxFileName(1n, txid)}`;
        await store.put(
          snapshot,
          encodeLtx({
            header: {
              pageSize,
              commit,
              minTXID: 1n,
              maxTXID: txid,
              timestamp: now(),
              preApplyChecksum: 0n,
            },
            pages,
            postApplyChecksum: 0n,
          }),
        );
        for (const key of before) {
          const r = range(key);
          if (key !== snapshot && r && r.max <= txid) await store.delete(key);
        }
      });
    },

    async load(cellKey: string) {
      const scope = scopeOf(cellKey);
      const byEpoch = new Map<number, { key: string; min: bigint; max: bigint }[]>();
      for (const key of await store.list(`cells/${scope}/ltx/e`)) {
        const r = range(key);
        if (!r) continue;
        const list = byEpoch.get(r.epoch) ?? [];
        list.push({ key, min: r.min, max: r.max });
        byEpoch.set(r.epoch, list);
      }
      // The newest epoch whose files chain from a snapshot (TXID 1): files in TXID order; a
      // snapshot restarts the image, a file already covered is skipped, a gap ends the chain.
      for (const epoch of [...byEpoch.keys()].sort((a, b) => b - a)) {
        const files = byEpoch
          .get(epoch)!
          .sort((a, b) => (a.max !== b.max ? (a.max < b.max ? -1 : 1) : a.min < b.min ? -1 : 1));
        if (!files.some((f) => f.min === 1n)) continue;
        const pages = new Map<number, Uint8Array>();
        let pageSize = 0;
        let commit = 0;
        let next = 1n;
        let started = false;
        for (const f of files) {
          if (f.max < next) continue;
          if (f.min !== 1n && (!started || f.min !== next)) {
            if (started) break;
            continue;
          }
          const ltx = decodeLtx((await store.get(f.key))!.body);
          if (f.min === 1n) pages.clear();
          for (const [p, d] of ltx.pages) pages.set(p, d);
          pageSize = ltx.header.pageSize;
          commit = ltx.header.commit;
          next = f.max + 1n;
          started = true;
        }
        if (!started) continue;
        const image = new Uint8Array(commit * pageSize);
        for (let p = 1; p <= commit; p++) {
          const d = pages.get(p);
          if (d) image.set(d, (p - 1) * pageSize);
        }
        return toRollback(image);
      }
      return undefined;
    },
  };

  return Object.assign(durability, {
    /** A new owner epoch for the cell: its next commit opens the generation with a snapshot. */
    begin(cellKey: string, epoch: number) {
      cells.set(cellKey, { epoch, txid: 0n, pages: undefined });
    },
    /** The cell is no longer ours (lease lost): forget its writer state. */
    forget(cellKey: string) {
      cells.delete(cellKey);
    },
  });
}
