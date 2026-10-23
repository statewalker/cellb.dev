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
  /** The waker-role lease (celld: 3 × its due-scan tick); match 3 × the runtime's wakePollMs. */
  wakerTtlMs?: number;
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let leaseWritten: Promise<void> | undefined;

  /** nodes/<node>.json, renewed every ttl/3; a failed renewal stops every cell (self-fencing). */
  // celld decodes every node record (ownership_store.rs NodeLeaseWire / NodeLoadWire): a record
  // missing a required load field breaks its fleet posture repair. This one is complete. It
  // reports pressure and zero placement weight, so celld never offers this node a cell — it
  // takes cells only when a request arrives.
  //
  // The address must not be empty: celld treats a live owner WITHOUT an address as dead and
  // takes its cells over (logic/lib.rs apply_node_lease_result) — a split brain. With an
  // address celld routes a request for our cell to it; a node that does not accept celld's
  // peer protocol (a browser) gets an unroutable placeholder, so the request fails instead.
  let addr = opts.addr || `${opts.node}.webrun-cells.invalid:9`;
  // celld's per-process generation is its signed-probe public key (Ed25519, peer_probe.rs):
  // `probe_public_key` = `ownership_index_generation`. A real key lets `celld diagnose --peer`
  // verify that a probe reached this node.
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  let generation = hex(crypto.getRandomValues(new Uint8Array(32)));
  let probeKey: CryptoKey | undefined;
  const probeKeyReady = (async () => {
    try {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      probeKey = pair.privateKey;
      generation = hex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    } catch {
      // no Ed25519 in this WebCrypto: the record keeps a random generation (probes then fail)
    }
  })();
  let validUntil = 0;
  const writeLease = async () => {
    const t = now();
    const body = {
      node: opts.node,
      expires_ms: t + ttl,
      addr,
      probe_public_key: generation,
      peer_protocol: 5,
      paced_handoff: false,
      ownership_index_generation: generation,
      load: {
        sampled_ms: t,
        owned_cells: owned.size,
        placement_weight: 0,
        bucket_format: 2,
        resident_cells: owned.size,
        host_websockets: 0,
        rss_bytes: 0,
        in_use_bytes: 0,
        cpu_percent_x100: 0,
        open_fds: 0,
        fd_limit: 0,
        pressured: true,
        memory_headroom: false,
        shed_cells: 0,
        restoring: 0,
        rebalance_paused: false,
        draining: false,
      },
    };
    await store.put(`nodes/${opts.node}.json`, enc.encode(JSON.stringify(body)));
    // Our authority lasts until the record we just wrote expires — minus a margin, so a node
    // that stalls (a paused process, a frozen tab) stops acknowledging before celld may take
    // over: celld waits for expires_ms; we stop at expires_ms - margin.
    validUntil = t + ttl - Math.min(1_000, ttl / 4);
  };
  const owned = new Set<string>();
  const ensureLease = () => {
    leaseWritten ??= probeKeyReady.then(writeLease).then(() => {
      const tick = () => {
        renew = setTimeout(() => {
          writeLease().then(tick, (e) => lost.abort(e));
        }, ttl / 3);
        // If renewals stop arriving (a stalled process, an unreachable bucket), every cell
        // stops at the local deadline — before celld may take it over.
        if (deadline) clearTimeout(deadline);
        deadline = setTimeout(
          () => {
            if (now() >= validUntil)
              lost.abort(new Error(`node ${opts.node}: lease deadline passed`));
          },
          Math.max(0, validUntil - now()),
        );
        (deadline as { unref?: () => void }).unref?.();
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
  // A write is acknowledged only while our node lease is still ours (self-fencing).
  const log = ltxLog(store, { now, authorized: () => now() < validUntil });

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
      owned.add(cellKey);
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
          owned.delete(cellKey);
        },
      };
    },
  };

  // celld's waker role (wake.rs try_hold_waker): one node per fleet wakes alarms of cells that
  // nobody owns or whose owner is dead — an advisory CAS lease in wake/waker.json; every node
  // wakes its own cells; a live owner's cells are never hinted.
  const holdWaker = async (ttlMs: number) => {
    const key = "wake/waker.json";
    const cur = await readJson<{ node: string; expires_ms: number }>(key);
    const t = now();
    if (cur && cur.value.node !== opts.node && cur.value.expires_ms > t) return false;
    try {
      await store.put(
        key,
        enc.encode(JSON.stringify({ node: opts.node, expires_ms: t + ttlMs })),
        cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" },
      );
      return true;
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) return false;
      const again = await readJson<{ node: string; expires_ms: number }>(key);
      return again?.value.node === opts.node && again.value.expires_ms > t;
    }
  };
  const allWakes = log.wakes!.bind(log);
  const durability = Object.assign(log, {
    async wakes() {
      const due = await allWakes();
      let elected: boolean | undefined;
      const out: typeof due = [];
      for (const w of due) {
        const own = await readJson<{ node: string }>(`cells/${scopeOf(w.cellKey)}/own.json`);
        const owner = own?.value.node;
        if (owner === opts.node) {
          out.push(w); // our own cell: always
          continue;
        }
        let ownerExpires = 0;
        if (owner) {
          const lease = await readJson<{ expires_ms: number }>(`nodes/${owner}.json`);
          ownerExpires = lease?.value.expires_ms ?? 0;
        }
        elected ??= await holdWaker(opts.wakerTtlMs ?? 90_000);
        if (!elected) continue; // unowned or dead owners are the elected waker's job
        // A live owner fires its own alarms; the waker looks again when that owner's lease
        // would have run out (a stopped owner's cells are then due here).
        out.push(ownerExpires > now() ? { ...w, at: Math.max(w.at, ownerExpires + 1) } : w);
      }
      return out;
    },
  });

  return {
    ownership,
    durability,
    /** The fleet bucket itself (R2 objects live directly in it, under `r2/<bucket>/`). */
    store,
    /**
     * The address celld nodes reach this node at (its celld peer server): published in the
     * node record now, so celld routes requests for our cells here instead of refusing them.
     */
    /**
     * Answers celld's signed peer probe (peer_probe.rs): an Ed25519 signature over
     * "cells-peer-probe-v1\n<node>\n<advertised addr>\n<challenge>" by this node's probe key.
     */
    async probe(challenge: string) {
      await probeKeyReady;
      if (!probeKey || !/^[0-9a-f]{64}$/.test(challenge))
        throw new Error("cannot answer the probe");
      const payload = `cells-peer-probe-v1\n${opts.node}\n${addr}\n${challenge}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", probeKey, new TextEncoder().encode(payload)),
      );
      return { version: 1, node: opts.node, advertise: addr, challenge, signature: hex(signature) };
    },
    async advertise(address: string) {
      addr = address;
      if (leaseWritten) await writeLease();
    },
    /** Clean shutdown: stop renewing and remove this node's lease record. */
    async close() {
      if (renew) clearTimeout(renew);
      if (deadline) clearTimeout(deadline);
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
