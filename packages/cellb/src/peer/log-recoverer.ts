import type { LogRecord, NodeRecord } from "../bucket/celld-cells.js";
import { type ObjectStore, PreconditionFailedError } from "../bucket/object-store.js";
import { ltxFileName } from "../ltx/ltx.js";
import { loadPeerKey, signPeerRequest } from "./celld-peer.js";
import { decodeTail, type SealResp, type ShipEntry, type Tail } from "./log-follower.js";

/**
 * Recovers a dead leader's log tier session (celld 0.6.3 crates/celld/node_log.rs recovery,
 * logic/log_tier.rs; statewalker/cellb.dev#209), whether a celld or a cellb node led it:
 *
 *   1. the leader's record must have expired with its `log` not sealed;
 *   2. claim it: {state: recovering, claimant: this node, claimed_ms} by compare-and-swap,
 *      refreshed every 5 s; a fresher claim of another node is left alone (30 s staleness);
 *   3. seal every member of the session's ensemble at its epoch, then read its tail (CLT2);
 *   4. an `active` session (it may have acknowledged on its followers) needs one complete
 *      witness; without one, a member that may still come back makes the outcome unknown (fail,
 *      try again later), otherwise the loss is recorded (log/<session>.e<epoch>.loss.json);
 *   5. every gathered row (cell, cell epoch, TXID) above the highest TXID the bucket lists for
 *      that cell epoch is uploaded, in TXID order, as cells/<cell>/ltx/e<E>/0000/<t>-<t>.ltx;
 *   6. the record becomes {state: sealed, claimant: null, claimed_ms: null}.
 *
 * The session's cells can then be taken (the takeover gate waits for `sealed`). A session with
 * node bundles (log/<session>/bundle/, a celld leader's tiering) is left to celld: cellb does not
 * read celld's bundle format.
 */
export interface LogRecovererOptions {
  store: ObjectStore;
  /** This node's name: the claimant. */
  node: string;
  /** How often sweep() runs once started (celld: its 30 s maintenance tick). */
  sweepMs?: number;
  /** A claim not refreshed for this long is stale and may be taken over (celld: 30 s). */
  claimTtlMs?: number;
  /**
   * A member that cannot be reached counts as gone (its data lost) only once its own record has
   * been expired this long; before that its fate is unknown (celld: max(3 × lease, 20 s)).
   */
  memberGraceMs?: number;
  fetch?: typeof fetch;
}

export type RecoverOutcome = "sealed" | "none" | "live" | "claimed" | "bundles";

export interface LogRecoverer {
  /** Recovers the session in `nodes/<node>.json`, if it needs it. */
  recover(node: string): Promise<RecoverOutcome>;
  /** Recovers every expired session that is not sealed (other nodes'). */
  sweep(): Promise<void>;
  start(): void;
  close(): void;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowKey = (e: ShipEntry) => `${e.cell}\n${e.cellEpoch}\n${e.txid}`;

export function createLogRecoverer(o: LogRecovererOptions): LogRecoverer {
  const f = o.fetch ?? fetch;
  const claimTtl = o.claimTtlMs ?? 30_000;
  const memberGrace = o.memberGraceMs ?? 20_000;
  let key: Promise<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;

  const read = async (node: string) => {
    const obj = await o.store.get(`nodes/${node}.json`);
    return obj
      ? { rec: JSON.parse(dec.decode(obj.body)) as NodeRecord, etag: obj.etag }
      : undefined;
  };
  /** Rewrites the record's `log` only, by compare-and-swap (never expires_ms). */
  const casLog = async (node: string, etag: string, rec: NodeRecord, log: LogRecord) =>
    o.store.put(`nodes/${node}.json`, enc.encode(JSON.stringify({ ...rec, log })), {
      ifMatch: etag,
    });

  const post = async (member: string, addr: string, path: string, body: Uint8Array) => {
    key ??= loadPeerKey(o.store);
    const r = await f(`http://${addr}${path}`, {
      method: "POST",
      headers: {
        ...signPeerRequest(await key, o.node, member, "POST", path, body),
        "content-type": "application/json",
      },
      body: body as BodyInit,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`${member} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  /** Seal then tail one member: its rows, and whether it witnesses the whole session. */
  const gather = async (member: string, session: string, epoch: number) => {
    const m = await read(member);
    const reachableAddr =
      m?.rec.addr && !m.rec.addr.endsWith(".invalid:9") ? m.rec.addr : undefined;
    const gone = () => !m || m.rec.expires_ms + memberGrace <= Date.now();
    try {
      if (!reachableAddr) throw new Error(`${member} has no address`);
      const seal = JSON.parse(
        dec.decode(
          await post(
            member,
            reachableAddr,
            "/peer/log/seal",
            enc.encode(JSON.stringify({ leader: session, epoch })),
          ),
        ),
      ) as SealResp;
      const tail: Tail = decodeTail(
        await post(
          member,
          reachableAddr,
          "/peer/log/tail",
          enc.encode(JSON.stringify({ leader: session, tail_format: 2 })),
        ),
      );
      let contiguous = tail.complete && tail.base <= tail.end;
      for (let s = tail.base + 1, i = 0; contiguous && s <= tail.end; s++, i++)
        contiguous = tail.entries[i]?.seq === s;
      const witness =
        contiguous &&
        seal.held_fragment_epoch === epoch &&
        seal.fragment_epoch === seal.held_fragment_epoch &&
        tail.fragmentEpoch === seal.fragment_epoch &&
        tail.base === seal.base &&
        tail.end === seal.end;
      return { rows: tail.entries, witness, unknown: false };
    } catch {
      // Unreachable: its rows are lost only if it is long gone; otherwise the outcome is unknown.
      return { rows: [] as ShipEntry[], witness: false, unknown: !gone() };
    }
  };

  const uploadRows = async (rows: ShipEntry[]) => {
    const byCellEpoch = new Map<string, ShipEntry[]>();
    for (const r of rows) {
      const k = `${r.cell}\n${r.cellEpoch}`;
      const list = byCellEpoch.get(k) ?? [];
      list.push(r);
      byCellEpoch.set(k, list);
    }
    for (const list of byCellEpoch.values()) {
      const { cell, cellEpoch } = list[0];
      const prefix = `cells/${cell}/ltx/e${cellEpoch}/`;
      let covered = 0;
      for (const k of await o.store.list(prefix)) {
        const m = /\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(k);
        if (m) covered = Math.max(covered, Number.parseInt(m[2], 16));
      }
      for (const r of list.sort((a, b) => a.txid - b.txid)) {
        if (r.txid <= covered) continue;
        const t = BigInt(r.txid);
        await o.store.put(`${prefix}0000/${ltxFileName(t, t)}`, r.bytes);
      }
    }
  };

  const recoverOnce = async (node: string): Promise<RecoverOutcome> => {
    // 1–2. the record, and our claim on it
    let claimed: { rec: NodeRecord; etag: string; log: LogRecord } | undefined;
    for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
      const cur = await read(node);
      const log = cur?.rec.log;
      if (!cur || !log || log.state === "sealed") return "none";
      if (cur.rec.expires_ms > Date.now()) return "live";
      if (
        log.state === "recovering" &&
        log.claimant !== o.node &&
        log.claimed_ms != null &&
        log.claimed_ms + claimTtl > Date.now()
      )
        return "claimed";
      const mine: LogRecord = {
        ...log,
        state: "recovering",
        claimant: o.node,
        claimed_ms: Date.now(),
      };
      try {
        const etag = await casLog(node, cur.etag, cur.rec, mine);
        claimed = { rec: cur.rec, etag, log: mine };
      } catch (e) {
        if (!(e instanceof PreconditionFailedError)) throw e;
      }
    }
    if (!claimed) return "claimed";
    const generation = claimed.rec.ownership_index_generation || claimed.rec.probe_public_key;
    const session = `${node}/${generation}`;
    // the claim stays fresh while we work
    let held = claimed;
    let lostClaim = false;
    const beat = setInterval(async () => {
      const cur = await read(node).catch(() => undefined);
      if (!cur?.rec.log || cur.rec.log.claimant !== o.node) {
        lostClaim = true;
        return;
      }
      const log = { ...cur.rec.log, claimed_ms: Date.now() };
      try {
        held = { rec: cur.rec, etag: await casLog(node, cur.etag, cur.rec, log), log };
      } catch {}
    }, 5_000);
    try {
      if ((await o.store.list(`log/${session}/bundle/`)).length) return "bundles"; // celld's to fold
      // 3. seal and gather every member
      const results = await Promise.all(
        held.log.ensemble.map((m) => gather(m, session, held.log.epoch)),
      );
      const rows = new Map<string, ShipEntry>();
      for (const r of results) for (const e of r.rows) rows.set(rowKey(e), e);
      // 4. a session that may have acknowledged on its followers needs a witness
      if (held.log.active && !results.some((r) => r.witness)) {
        if (results.some((r) => r.unknown))
          throw new Error(
            `${session}: no follower can witness epoch ${held.log.epoch} yet; recovery will try again`,
          );
        await o.store.put(
          `log/${session}.e${held.log.epoch}.loss.json`,
          enc.encode(
            JSON.stringify({
              leader: session,
              epoch: held.log.epoch,
              declared_at_ms: Date.now(),
              declared_by: o.node,
              ensemble: held.log.ensemble,
              note: "no follower holds the epoch's acknowledged writes",
            }),
          ),
        );
      }
      // 5. what the bucket lacks
      await uploadRows([...rows.values()]);
      if (lostClaim) throw new Error(`${session}: another node took the recovery over`);
      // 6. sealed, if the claim is still ours
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await read(node);
        if (!cur?.rec.log || cur.rec.log.claimant !== o.node)
          throw new Error(`${session}: another node took the recovery over`);
        try {
          await casLog(node, cur.etag, cur.rec, {
            ...cur.rec.log,
            state: "sealed",
            claimant: null,
            claimed_ms: null,
          });
          return "sealed";
        } catch (e) {
          if (!(e instanceof PreconditionFailedError)) throw e;
          await sleep(50);
        }
      }
      throw new Error(`${session}: the record kept changing; recovery will try again`);
    } finally {
      clearInterval(beat);
    }
  };

  const inFlight = new Map<string, Promise<RecoverOutcome>>();
  const recover = (node: string) => {
    let p = inFlight.get(node);
    if (!p) {
      p = recoverOnce(node).finally(() => inFlight.delete(node));
      inFlight.set(node, p);
    }
    return p;
  };

  return {
    recover,
    sweep() {
      sweeping ??= (async () => {
        try {
          for (const k of await o.store.list("nodes/")) {
            const node = k.slice("nodes/".length, -".json".length);
            if (node === o.node) continue;
            const cur = await read(node).catch(() => undefined);
            const log = cur?.rec.log;
            if (!log || log.state === "sealed" || cur.rec.expires_ms > Date.now()) continue;
            await recover(node).catch(() => {}); // the next sweep tries again
          }
        } finally {
          sweeping = undefined;
        }
      })();
      return sweeping;
    },
    start() {
      timer ??= setInterval(() => void this.sweep().catch(() => {}), o.sweepMs ?? 30_000);
      (timer as { unref?: () => void }).unref?.();
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
