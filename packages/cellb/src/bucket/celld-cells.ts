import { decodeLtx, encodeLtx, ltxFileName } from "../ltx/ltx.js";
import type { BackupInfo, CellBackup, CellDurability } from "../ports.js";
import { type ObjectStore, PreconditionFailedError } from "./object-store.js";

/**
 * Cells stored the way celld stores them (docs/guarantees.md, and the keys celld dev writes
 * in `.celld/dev/objects.sqlite3`), on any ObjectStore:
 *
 *   cells/<Class>:<idHex>/own.json                     {"node","epoch"}: ownership record
 *   cells/<Class>:<idHex>/ltx/e<epoch>/0000/<min>-<max>.ltx   LTX v3, legacy LZ4 frames
 *   nodes/<node>.json                                  {"node","expires_ms","addr",…}: node lease
 *
 * Ownership: an activation creates the record (If-None-Match) or advances its epoch with a
 * compare-and-swap (If-Match), taking over only from a node whose lease expired. Durability:
 * each committed transaction becomes an LTX file in the cell's current epoch prefix — the
 * first one a snapshot (TXID 1), then the changed pages — and the output gate waits for the
 * PUT. Restore: the newest epoch that starts with a snapshot, its files in TXID order.
 */
export interface CelldBucketOptions {
  /** This node's name (celld: `dev-…` / the fleet node name). */
  node: string;
  addr?: string;
  leaseTtlMs?: number;
  now?: () => number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const scopeOf = (cellKey: string) => cellKey.replace("/", ":");
const pad16 = (n: bigint) => n.toString(16).padStart(16, "0");

export function celldBucket(store: ObjectStore, opts: CelldBucketOptions) {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.leaseTtlMs ?? 10_000;
  const lost = new AbortController();
  let renew: ReturnType<typeof setTimeout> | undefined;
  let leaseWritten: Promise<void> | undefined;

  /** nodes/<node>.json, renewed every ttl/3; a failed renewal stops every cell (self-fencing). */
  const writeLease = async () => {
    const body = {
      node: opts.node,
      expires_ms: now() + ttl,
      addr: opts.addr ?? "",
      peer_protocol: 5,
      load: { owned_cells: 0 },
    };
    await store.put(`nodes/${opts.node}.json`, enc.encode(JSON.stringify(body)));
  };
  const ensureLease = () => {
    leaseWritten ??= writeLease().then(() => {
      const tick = () => {
        renew = setTimeout(() => {
          writeLease().then(tick, (e) => lost.abort(e));
        }, ttl / 3);
        (renew as { unref?: () => void }).unref?.();
      };
      tick();
    });
    return leaseWritten;
  };

  const readJson = async <T>(key: string) => {
    const o = await store.get(key);
    return o ? { value: JSON.parse(dec.decode(o.body)) as T, etag: o.etag } : undefined;
  };

  // Per cell: the epoch it writes into and the pages last written (for incremental files).
  const cells = new Map<
    string,
    { epoch: number; txid: bigint; pages: Map<number, Uint8Array> | undefined }
  >();

  const ownership = {
    async tryAcquire(cellKey: string) {
      await ensureLease();
      const scope = scopeOf(cellKey);
      const key = `cells/${scope}/own.json`;
      const cur = await readJson<{ node: string; epoch: number }>(key);
      let epoch: number;
      try {
        if (!cur) {
          epoch = 1;
          await store.put(key, enc.encode(JSON.stringify({ node: opts.node, epoch })), {
            ifNoneMatch: "*",
          });
        } else {
          const holder = cur.value.node;
          if (holder && holder !== opts.node) {
            const lease = await readJson<{ expires_ms: number }>(`nodes/${holder}.json`);
            if (lease && lease.value.expires_ms > now()) return undefined; // a live owner
          }
          epoch = cur.value.epoch + 1; // every activation advances the epoch
          await store.put(key, enc.encode(JSON.stringify({ node: opts.node, epoch })), {
            ifMatch: cur.etag,
          });
        }
      } catch (e) {
        if (e instanceof PreconditionFailedError) return undefined; // another node won the race
        throw e;
      }
      cells.set(cellKey, { epoch, txid: 0n, pages: undefined });
      return {
        name: cellKey,
        epoch,
        lost: lost.signal,
        release: async () => {
          const now2 = await readJson<{ node: string; epoch: number }>(key);
          if (now2?.value.node === opts.node && now2.value.epoch === epoch)
            await store
              .put(key, enc.encode(JSON.stringify({ node: "", epoch })), { ifMatch: now2.etag })
              .catch(() => {});
          cells.delete(cellKey);
        },
      };
    },
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
      const cell = cells.get(cellKey) ?? { epoch: info.epoch ?? 1, txid: 0n, pages: undefined };
      cells.set(cellKey, cell);
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

    async save(_cellKey: string, _image: Uint8Array, _info: BackupInfo) {
      // Every transaction is already in the bucket; periodic snapshots add nothing.
    },

    async load(cellKey: string) {
      const scope = scopeOf(cellKey);
      const keys = await store.list(`cells/${scope}/ltx/e`);
      const byEpoch = new Map<number, string[]>();
      for (const k of keys) {
        const m = /\/ltx\/e(\d+)\/\d+\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(k);
        if (!m) continue;
        const list = byEpoch.get(Number(m[1])) ?? [];
        list.push(k);
        byEpoch.set(Number(m[1]), list);
      }
      // The newest epoch that opened with a whole-database snapshot (TXID 1).
      for (const epoch of [...byEpoch.keys()].sort((a, b) => b - a)) {
        const files = byEpoch.get(epoch)!.sort();
        if (!files[0].includes(`/${pad16(1n)}-`)) continue;
        const pages = new Map<number, Uint8Array>();
        let pageSize = 0;
        let commit = 0;
        let next = 1n;
        for (const key of files) {
          const ltx = decodeLtx((await store.get(key))!.body);
          if (ltx.header.minTXID !== next) break; // a gap ends the chain
          for (const [p, d] of ltx.pages) pages.set(p, d);
          pageSize = ltx.header.pageSize;
          commit = ltx.header.commit;
          next = ltx.header.maxTXID + 1n;
        }
        const image = new Uint8Array(commit * pageSize);
        for (let p = 1; p <= commit; p++) {
          const d = pages.get(p);
          if (d) image.set(d, (p - 1) * pageSize);
        }
        // A restored cell continues with a snapshot in its own (newer) epoch.
        return toRollback(image);
      }
      return undefined;
    },
  };

  return {
    ownership,
    durability,
    /** The fleet bucket itself (R2 objects live directly in it, under `r2/<bucket>/`). */
    store,
    /** Clean shutdown: stop renewing and remove this node's lease record. */
    async close() {
      if (renew) clearTimeout(renew);
      if (leaseWritten) await store.delete(`nodes/${opts.node}.json`).catch(() => {});
    },
  };
}

const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const pageSizeOf = (image: Uint8Array) => {
  const v = (image[16] << 8) | image[17];
  return v === 1 ? 65536 : v;
};
/**
 * celld's cells run in WAL mode (header bytes 18–19 = 2); a restored image is switched to a
 * rollback journal (1/1) so any driver can open it from memory; SQLite rewrites them when a
 * runtime sets WAL again.
 */
const toRollback = (image: Uint8Array) => {
  if (image.length > 19 && image[18] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return image;
};
