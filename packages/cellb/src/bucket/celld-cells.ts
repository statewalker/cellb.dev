import { bytesToHex } from "@noble/hashes/utils.js";
import { scopeOf } from "../core/celld-schema.js";
import { decodeLtx, encodeLtx, ltxFileName } from "../ltx/ltx.js";
import type { BackupInfo, CellBackup, CellDurability } from "../ports.js";
import { equal, pad16, pageSizeOf, toRollback } from "./celld-format.js";
import { ltxLog, type SegmentShipper } from "./ltx-log.js";
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
  /**
   * A predecessor under this node's name left a log tier session that is not sealed (it died as
   * a leader): recover it before this node writes its own record (celld does the same before it
   * installs a new lease). Without it the node waits until another node has recovered it.
   */
  recoverPredecessor?: (session: string, record: NodeRecord) => Promise<void>;
  /** Our log tier session was taken over by a recoverer (a refused renewal): stop leading. */
  onLogLost?: () => void;
  /** The waker-role lease (celld: 3 × its due-scan tick); match 3 × the runtime's wakePollMs. */
  wakerTtlMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The `log` object of a node record: a leader's session in celld's log tier (ownership_store.rs). */
export interface LogRecord {
  state: "open" | "recovering" | "sealed";
  epoch: number;
  ensemble: string[];
  tiered: number;
  active: boolean;
  claimant: string | null;
  claimed_ms: number | null;
}
/** nodes/<node>.json, as far as cellb reads it. */
export interface NodeRecord {
  node: string;
  expires_ms: number;
  addr?: string;
  ownership_index_generation?: string;
  probe_public_key?: string;
  log?: LogRecord;
  [field: string]: unknown;
}

/** celld 0.6.3: how long a node refuses a cell whose ownership record it found lost. */
export const LOST_RECORD_RECHECK_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const lostRecordError = (scope: string) =>
  Object.assign(
    new Error(
      `ownership record lost: cells/${scope}/own.json is missing, but the bucket holds LTX under ` +
        `cells/${scope}/ltx/; refusing to claim ${scope} as a new cell (celld docs/guarantees.md: ` +
        `write a released record {"node": "", "epoch": <newest epoch>} to restore it)`,
    ),
    { name: "OwnershipRecordLostError" },
  );

/** The bucket's `close()` also closes `store` (when it has a `close`): pass a store of its own. */
export function celldBucket(store: ObjectStore & { close?(): void }, opts: CelldBucketOptions) {
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.leaseTtlMs ?? 10_000;
  // The cells' fence: aborted when this node's authority lapses, then replaced, so the cells it
  // takes again later (at the next epoch, once renewals land again) are fenced by the next lapse.
  let lost = new AbortController();
  let renew: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let leaseWritten: Promise<void> | undefined;
  /** The lease write on its way to the bucket, if any: `close()` waits for it before the delete. */
  let writing: Promise<unknown> = Promise.resolve();
  let closed = false;

  /** nodes/<node>.json, renewed every ttl/3; a failed renewal stops every cell (self-fencing). */
  // celld decodes every node record (ownership_store.rs NodeLeaseWire / NodeLoadWire): a record
  // missing a required load field breaks its fleet posture repair. This one is complete. It
  // reports zero placement weight and no paced hand-off, so celld never hands or rebalances a cell
  // to it. A node with a peer server reports headroom: celld's first-readiness gate keeps a
  // starting celld node unready while any live peer is pressured, and never fails open; a full
  // celld node may then route a new cell to it, which it serves. A node without one (a browser)
  // reports pressure, so celld places nothing on a node it cannot reach.
  //
  // The address must not be empty: celld treats a live owner WITHOUT an address as dead and
  // takes its cells over (logic/lib.rs apply_node_lease_result) — a split brain. With an
  // address celld routes a request for our cell to it; a node that does not accept celld's
  // peer protocol (a browser) gets an unroutable placeholder, so the request fails instead.
  let addr = opts.addr || `${opts.node}.cellb.invalid:9`;
  let advertised = !!opts.addr;
  // celld's per-process generation is its signed-probe public key (Ed25519, peer_probe.rs):
  // `probe_public_key` = `ownership_index_generation`. A real key lets `celld diagnose --peer`
  // verify that a probe reached this node.
  let generation = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  let probeKey: CryptoKey | undefined;
  const probeKeyReady = (async () => {
    try {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      probeKey = pair.privateKey;
      generation = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    } catch {
      // no Ed25519 in this WebCrypto: the record keeps a random generation (probes then fail)
    }
  })();
  let validUntil = 0;
  // Every lapse (a failed renewal, a passed deadline) fences the cells holding the current
  // signal, even when one fence was raised before: a cell taken in between holds a fresh signal.
  const fence = (reason: unknown) => {
    const was = lost;
    lost = new AbortController();
    was.abort(reason);
  };
  // Every write of our node record goes through one chain, by compare-and-swap on the etag of the
  // record we last wrote: the record carries our log tier session (`log`), which a recoverer may
  // take over when it judges this node dead, and a late renewal must never write over that.
  let leaseEtag: string | undefined;
  let leaseChain: Promise<unknown> = Promise.resolve();
  /** Our session's `log`, published with every write once set. */
  let logRecord: LogRecord | undefined;
  let everLogged = false;
  /** A renewal was refused (a recoverer took the record over): no writes until it is sealed. */
  let suspended = false;
  const leaseKey = `nodes/${opts.node}.json`;
  const writeLease = (expiresAt?: number) => {
    const w = leaseChain.catch(() => {}).then(() => putLease(expiresAt));
    leaseChain = w;
    // Every write in flight, not only the latest.
    writing = Promise.all([writing, w.catch(() => {})]);
    return w;
  };
  /** Before our first write: a record under our name from an earlier process. */
  const adoptPredecessor = async () => {
    for (;;) {
      const cur = await readJson<NodeRecord>(leaseKey);
      if (!cur) return;
      const rec = cur.value;
      const ours = (rec.ownership_index_generation || rec.probe_public_key) === generation;
      if (ours) {
        leaseEtag = cur.etag;
        return;
      }
      // A live process under our name: wait for its record to expire (celld waits too).
      if (rec.expires_ms > now()) {
        await sleep(Math.min(250, rec.expires_ms - now() + 1));
        continue;
      }
      // A dead predecessor that led a log tier session: its acknowledged writes may be only on
      // its followers until the session is recovered.
      if (rec.log && rec.log.state !== "sealed") {
        const session = `${opts.node}/${rec.ownership_index_generation || rec.probe_public_key}`;
        // Recovered here if we can; otherwise (another node's claim, celld's bundles) another
        // node does it: either way, look again after a pause, not at once.
        if (opts.recoverPredecessor) await opts.recoverPredecessor(session, rec).catch(() => {});
        await sleep(500);
        continue;
      }
      leaseEtag = cur.etag;
      return;
    }
  };
  const putLease = async (expiresAt?: number) => {
    if (closed && expiresAt === undefined) return;
    if (suspended) {
      // Taken over: write again only once the recoverer has sealed the session.
      const cur = await readJson<NodeRecord>(leaseKey);
      if (cur?.value.log && cur.value.log.state !== "sealed")
        throw new Error(`node ${opts.node}: its log tier session is being recovered`);
      leaseEtag = cur?.etag;
      logRecord = cur?.value.log;
      suspended = false;
    }
    if (leaseEtag === undefined && !leaseWrittenOnce) await adoptPredecessor();
    const t = now();
    const body: NodeRecord = {
      node: opts.node,
      expires_ms: expiresAt ?? t + ttl,
      addr,
      probe_public_key: generation,
      peer_protocol: 5,
      paced_handoff: false,
      ownership_index_generation: generation,
      ...(logRecord ? { log: logRecord } : {}),
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
        pressured: !advertised,
        memory_headroom: advertised,
        shed_cells: 0,
        restoring: 0,
        rebalance_paused: false,
        draining: false,
      },
    };
    try {
      leaseEtag = await store.put(
        leaseKey,
        enc.encode(JSON.stringify(body)),
        leaseEtag === undefined ? { ifNoneMatch: "*" } : { ifMatch: leaseEtag },
      );
      leaseWrittenOnce = true;
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        // Someone else wrote our record: a recoverer that judged this node dead. Its write
        // stands; our session is over, and this node is fenced until it is sealed.
        suspended = true;
        if (logRecord) opts.onLogLost?.();
      }
      throw e;
    }
    if (expiresAt !== undefined) return;
    // Our authority lasts until the record we just wrote expires — minus a margin, so a node
    // that stalls (a paused process, a frozen tab) stops acknowledging before celld may take
    // over: celld waits for expires_ms; we stop at expires_ms - margin.
    if (!closed) {
      validUntil = t + ttl - Math.min(1_000, ttl / 4);
      // Every write that moves the validity (renewals, advertise()) moves the deadline with it:
      // a deadline armed for an older validity fires early, finds the lease valid, and would
      // otherwise never fire again if the renewals after it stop landing (#178).
      armDeadline();
    }
  };
  let leaseWrittenOnce = false;
  /** If renewals stop arriving (a stalled process, an unreachable bucket), every cell stops at
   * the local deadline — before celld may take it over. */
  const armDeadline = () => {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(
      () => {
        if (closed) return;
        if (now() >= validUntil) fence(new Error(`node ${opts.node}: lease deadline passed`));
        // Fired before the lease's clock reached the deadline (timers round; `now` may not be
        // Date.now): wait for the rest, or no deadline is left while renewals are stuck.
        else armDeadline();
      },
      Math.max(1, validUntil - now()),
    );
    (deadline as { unref?: () => void }).unref?.();
  };
  const owned = new Set<string>();
  /** Cells whose ownership record was found lost, with the time their refusal ends. */
  const lostRecords = new Map<string, number>();
  const ensureLease = () => {
    leaseWritten ??= probeKeyReady
      .then(() => writeLease())
      .then(() => {
        const tick = () => {
          if (closed) return;
          renew = setTimeout(() => {
            // A failed renewal stops every cell (self-fencing); the node keeps renewing, so it
            // can take cells again once the bucket answers.
            writeLease().then(tick, (e) => {
              fence(e);
              tick();
            });
          }, ttl / 3);
          armDeadline();
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
  const log = ltxLog(store, { now, authorized: () => !closed && now() < validUntil });

  const ownership = {
    async tryAcquire(cellKey: string) {
      await ensureLease();
      // Our own segments of the cell still on their way (a release that could not wait for
      // them): in the bucket first, or the restore below would miss them.
      await log.flush(cellKey);
      // No claim while this node's authority has lapsed: no deadline is left to fence a cell
      // taken now, and a late renewal could make its writes acknowledged again after its node
      // record had expired and another node took the cell (a split brain).
      const lapsed = () =>
        new Error(`node ${opts.node}: lease lapsed; ${cellKey} is not claimed until it is renewed`);
      if (now() >= validUntil) throw lapsed();
      const fenced = lost.signal; // the fence this claim answers to
      const scope = scopeOf(cellKey);
      const key = `cells/${scope}/own.json`;
      const t0 = now();
      if ((lostRecords.get(scope) ?? 0) > t0) throw lostRecordError(scope); // still refused
      let cur = await readJson<{ node: string; epoch: number }>(key);
      // celld 0.6.3 (actor.rs read_owner_for_claim): a missing record next to LTX means the
      // record was LOST (e.g. a lifecycle rule) — claiming epoch 1 would start the cell empty.
      // Read once more, then refuse the cell for 10 s without asking the bucket again.
      if (!cur && (await store.list(`cells/${scope}/ltx`)).length > 0) {
        cur = await readJson<{ node: string; epoch: number }>(key);
        if (!cur) {
          lostRecords.set(scope, t0 + LOST_RECORD_RECHECK_MS);
          throw lostRecordError(scope);
        }
      }
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
            const lease = await readJson<{ expires_ms: number; log?: { state?: string } }>(
              `nodes/${holder}.json`,
            );
            if (lease && lease.value.expires_ms > now()) return undefined; // a live owner
            // celld's takeover recovery gate (log_tier.rs takeover_gate): a celld owner in
            // fleet durability acknowledges writes its followers hold before they reach the
            // cell's prefix. Until a celld node has recovered the dead owner's node log into
            // the per-cell prefixes and marked it sealed, the bucket is not complete for this
            // cell: not ours to take. A record without `log` never acknowledged past the bucket.
            const log = lease?.value.log;
            if (log && log.state !== "sealed") return undefined;
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
      // Fenced while claiming: an aborted signal never fires again, so the cell must not start.
      // The record names this node at the new epoch; the next claim takes the one after it.
      if (fenced.aborted) throw lapsed();
      log.begin(cellKey, epoch); // a new owner epoch starts a new generation
      owned.add(cellKey);
      return {
        name: cellKey,
        epoch,
        lost: fenced,
        release: async () => {
          // The next owner restores from the bucket: every segment of ours is there first. One the
          // followers acknowledged that does not land (the bucket is down) keeps the record naming
          // this node: the takeover gate then waits for our session's recovery, which has it.
          if (!(await log.flush(cellKey, ttl))) {
            log.forget(cellKey);
            owned.delete(cellKey);
            return;
          }
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
    backup: durability,
    /** The fleet bucket itself (R2 objects live directly in it, under `r2/<bucket>/`). */
    objects: store,
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
      return {
        version: 1,
        node: opts.node,
        advertise: addr,
        challenge,
        signature: bytesToHex(signature),
      };
    },
    async advertise(address: string) {
      addr = address;
      advertised = true;
      if (leaseWritten) await writeLease();
    },
    /** Settles once the cell's segments are in the bucket. */
    flush(cellKey: string) {
      return log.flush(cellKey);
    },
    /** A log tier leader: commits are acknowledged by its followers or the bucket, first wins. */
    setShipper(shipper: SegmentShipper | undefined) {
      log.setShipper(shipper);
    },
    /** This node's log tier session id, `<node>/<generation>` (celld's session identity). */
    async session() {
      await probeKeyReady;
      return `${opts.node}/${generation}`;
    },
    /**
     * Publishes our log tier session's `log` in the node record and resolves once that write has
     * applied (celld: a leader waits for the renewal that carries it). Rejects if it did not.
     */
    async setLog(log: LogRecord) {
      logRecord = log;
      everLogged = true;
      await ensureLease();
      await writeLease();
    },
    /** The `log` this node last published (undefined: it leads no session). */
    get log() {
      return logRecord;
    },
    /** Clean shutdown: stop renewing, remove this node's lease record, close the store. */
    async close() {
      closed = true;
      if (renew) clearTimeout(renew);
      if (deadline) clearTimeout(deadline);
      validUntil = 0; // no write is acknowledged once closing has begun
      // A renewal already on its way would write the record back after the delete, and the
      // node's cells would stay "owned by a live node" for a whole lease: let it land first —
      // for at most a lease, since one that lands later expires within a lease anyway.
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([writing, new Promise((r) => (waited = setTimeout(r, ttl)))]);
      clearTimeout(waited);
      if (leaseWritten) {
        // A record that carries a log tier session stays (celld never deletes one: followers and
        // recoverers read it); expired, so the cells can be taken at once. Without one, it goes.
        if (everLogged) await writeLease(now()).catch(() => {});
        else await store.delete(leaseKey).catch(() => {});
      }
      store.close?.();
    },
  };
}
