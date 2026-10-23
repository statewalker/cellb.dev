import { decodeLtx, encodeLtx, ltxFileName } from "../ltx/ltx.js";
import type { BackupInfo, CellBackup, CellDurability } from "../ports.js";
import { ltxLog } from "./ltx-log.js";
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
export const pad16 = (n: bigint) => n.toString(16).padStart(16, "0");

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

  // One LTX writer (ltx-log.ts) holds each cell's epoch, TXID and page mirror.
  const log = ltxLog(store, { now });

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
      log.begin(cellKey, epoch); // a new owner epoch starts a new generation
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
          log.forget(cellKey);
        },
      };
    },
  };

  const durability = log;

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

export const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
export const pageSizeOf = (image: Uint8Array) => {
  const v = (image[16] << 8) | image[17];
  return v === 1 ? 65536 : v;
};
/**
 * celld's cells run in WAL mode (header bytes 18–19 = 2); a restored image is switched to a
 * rollback journal (1/1) so any driver can open it from memory; SQLite rewrites them when a
 * runtime sets WAL again.
 */
export const toRollback = (image: Uint8Array) => {
  if (image.length > 19 && image[18] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return image;
};
