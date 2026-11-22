import type { celldBucket, LogRecord, NodeRecord } from "../bucket/celld-cells.js";
import type { SegmentShipper } from "../bucket/ltx-log.js";
import type { ObjectStore } from "../bucket/object-store.js";
import { loadPeerKey, signPeerRequest } from "./celld-peer.js";
import { type AppendResp, encodeAppend, type ShipEntry } from "./log-follower.js";

/**
 * A LEADER in celld's log tier (celld 0.6.3 crates/celld/node_log.rs, logic/log_tier.rs,
 * docs/guarantees.md "The acknowledgement rule"): this node ships each commit's L0 LTX segment to
 * up to two followers (celld or cellb nodes) and a commit is acknowledged once every follower holds
 * it on disk — or once its upload lands, whichever is first (the bucket stays the store; see
 * ltx-log.ts). The session lives in this node's own record (`log` in nodes/<node>.json, written by
 * compare-and-swap through the lease chain):
 *
 *   open an epoch  — {state: open, epoch: n+1, ensemble, active: false}, only once nothing shipped
 *                    in the last epoch is missing from the bucket (the barrier); seq starts at 1;
 *   first ack      — {active: true} written and applied before any commit is credited to the
 *                    followers (a recoverer then requires a follower's witness);
 *   any failure    — the epoch degrades: commits wait for the bucket until the next epoch;
 *   close          — no more shipping, uploads drained, {state: sealed} (nothing left to recover).
 *
 * A follower that answers 404/405/501 (it cannot follow) is quarantined for 5 minutes, as celld
 * does. Hedging, probes, eviction of slow followers and node bundles are optional in celld's
 * protocol, and not done here.
 */
export interface LogLeaderOptions {
  bucket: ReturnType<typeof celldBucket>;
  /** The fleet bucket (node records, the peer secret). */
  store: ObjectStore;
  node: string;
  /** Followers per epoch (celld recruits up to 2). */
  maxFollowers?: number;
  /** How often the ensemble is maintained (default 2 s). */
  maintainMs?: number;
  /** An append not answered by then fails its round (celld: 1.5 s backstop + 100 ms). */
  appendTimeoutMs?: number;
  quarantineMs?: number;
  /** HTTP for the appends (tests). */
  fetch?: typeof fetch;
}

export interface LogLeader {
  shipper: SegmentShipper;
  /** Starts maintaining the ensemble every `maintainMs`. */
  start(): void;
  /** One maintenance step: open an epoch when there is none, or a healthier one is possible. */
  maintain(): Promise<void>;
  /** A recoverer took our session over (the lease chain saw it): stop leading. */
  lost(): void;
  /** Settles once every round shipped so far has been confirmed or has failed. */
  settled(): Promise<void>;
  /** Stops shipping, waits for the bucket, seals the session. */
  close(): Promise<void>;
}

interface Member {
  node: string;
  addr: string;
  lane: Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createLogLeader(o: LogLeaderOptions): LogLeader {
  const f = o.fetch ?? fetch;
  const maxFollowers = o.maxFollowers ?? 2;
  const appendTimeoutMs = o.appendTimeoutMs ?? 1_600;
  const quarantineMs = o.quarantineMs ?? 300_000;
  let key: Promise<Uint8Array> | undefined;
  let session: string | undefined;

  // The current epoch, when one is open and healthy.
  let epoch = 0;
  let members: Member[] = [];
  let healthy = false;
  let activated: Promise<void> | undefined;
  let seq = 0;
  /** Rows shipped in this epoch and whether each is in the bucket yet. */
  const rows: { seq: number; uploaded: boolean }[] = [];
  let truncateTo = 0;
  /** Credits commits to the followers strictly in submission order. */
  let credited: Promise<void> = Promise.resolve();
  const quarantined = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintaining: Promise<void> | undefined;

  const degrade = () => {
    healthy = false;
  };

  /** Rows not in the bucket yet (the barrier for a new epoch, and for sealing). */
  const pending = () => rows.some((r) => !r.uploaded);
  const advanceTruncate = () => {
    let t = truncateTo;
    for (const r of rows) {
      if (r.seq <= t) continue;
      if (!r.uploaded || r.seq !== t + 1) break;
      t = r.seq;
    }
    truncateTo = t;
    while (rows.length && rows[0].seq <= truncateTo) rows.shift();
  };

  const post = async (m: Member, body: Uint8Array): Promise<AppendResp> => {
    key ??= loadPeerKey(o.store);
    const path = "/peer/log/append";
    const headers = signPeerRequest(await key, o.node, m.node, "POST", path, body);
    let r: Response;
    try {
      r = await f(`http://${m.addr}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream" },
        body: body as BodyInit,
        signal: AbortSignal.timeout(appendTimeoutMs),
      });
    } catch (e) {
      throw Object.assign(new Error(`follower ${m.node}: ${(e as Error).message}`), { cause: e });
    }
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      // It cannot follow: celld's "incapable" answer.
      quarantined.set(m.node, Date.now() + quarantineMs);
      throw new Error(`follower ${m.node} cannot serve log appends (${r.status})`);
    }
    if (!r.ok) throw new Error(`follower ${m.node} answered ${r.status}`);
    const resp = (await r.json()) as AppendResp;
    if (typeof resp?.ok !== "boolean" || typeof resp.end !== "number") {
      quarantined.set(m.node, Date.now() + quarantineMs);
      throw new Error(`follower ${m.node}: not a log append answer`);
    }
    return resp;
  };

  /** `active: true` in the record, applied, before the epoch's first fleet acknowledgement. */
  const activate = (at: number) =>
    (activated ??= (async () => {
      const log = o.bucket.log;
      if (!log || log.epoch !== at || log.state !== "open") throw new Error("the epoch is over");
      if (!log.active) await o.bucket.setLog({ ...log, active: true });
    })());

  const shipper: SegmentShipper = {
    ship(seg) {
      if (!healthy || stopped || !session) return undefined;
      const at = epoch;
      const s = ++seq;
      const row = { seq: s, uploaded: false };
      rows.push(row);
      const entry: ShipEntry = { seq: s, ...seg };
      const frame = encodeAppend({ leader: session, epoch: at, truncateTo, entries: [entry] });
      // Each member gets the frames in order (its lane); the round confirms when all of them do.
      const answers = members.map((m) => {
        const sent = m.lane.then(() => post(m, frame));
        m.lane = sent.catch(() => {});
        const confirmed = sent.then((resp) => {
          if (!(resp.ok || (resp.epoch === at && resp.end >= s)))
            throw new Error(`follower ${m.node} refused seq ${s} of epoch ${at}`);
        });
        confirmed.catch(() => {}); // the round reports the first failure
        return confirmed;
      });
      const round = Promise.all(answers).then(() => activate(at));
      // A round after a failed one is never awaited (the credit chain fails first): it must not
      // be left rejected with no one listening.
      round.catch(() => {});
      // Rounds are credited in order: a failed one fails every later one of the epoch.
      const mine = credited.then(() => round);
      credited = mine;
      mine.catch(() => {
        if (epoch === at) degrade();
      });
      return {
        confirmed: mine,
        uploaded: () => {
          row.uploaded = true;
          advanceTruncate();
        },
      };
    },
  };

  /** Live peers that may follow: a record not expired, an address, the peer protocol. */
  const candidates = async (): Promise<{ node: string; addr: string }[]> => {
    const out: { node: string; addr: string }[] = [];
    const now = Date.now();
    for (const k of await o.store.list("nodes/")) {
      const name = k.slice("nodes/".length, -".json".length);
      if (name === o.node || (quarantined.get(name) ?? 0) > now) continue;
      const obj = await o.store.get(k).catch(() => undefined);
      if (!obj) continue;
      let rec: NodeRecord;
      try {
        rec = JSON.parse(new TextDecoder().decode(obj.body));
      } catch {
        continue;
      }
      if (
        rec.expires_ms <= now ||
        !rec.addr ||
        rec.addr.endsWith(".invalid:9") ||
        (rec as { peer_protocol?: number }).peer_protocol !== 5
      )
        continue;
      out.push({ node: name, addr: rec.addr });
    }
    return out.sort((a, b) => (a.node < b.node ? -1 : 1)).slice(0, maxFollowers);
  };

  const maintainOnce = async () => {
    if (stopped) return;
    session ??= await o.bucket.session();
    const found = await candidates();
    const improves = found.length > members.length;
    if (healthy && !improves) return;
    // The barrier: nothing shipped is missing from the bucket, nothing in flight.
    if (pending()) return;
    await Promise.allSettled(members.map((m) => m.lane));
    await credited.catch(() => {});
    if (!found.length) {
      degrade();
      return;
    }
    const prev = o.bucket.log;
    if (prev && prev.state === "recovering") return; // taken over: not ours to reopen
    const next: LogRecord = {
      state: "open",
      epoch: (prev?.epoch ?? 0) + 1,
      ensemble: found.map((c) => c.node).sort(),
      tiered: 0,
      active: false,
      claimant: null,
      claimed_ms: null,
    };
    degrade();
    await o.bucket.setLog(next); // applied before any append of the epoch
    epoch = next.epoch;
    members = found.map((c) => ({ ...c, lane: Promise.resolve() }));
    seq = 0;
    rows.length = 0;
    truncateTo = 0;
    activated = undefined;
    credited = Promise.resolve();
    healthy = !stopped;
  };

  return {
    shipper,
    start() {
      timer ??= setInterval(() => void this.maintain().catch(() => {}), o.maintainMs ?? 2_000);
      (timer as { unref?: () => void }).unref?.();
      void this.maintain().catch(() => {});
    },
    maintain() {
      maintaining ??= maintainOnce().finally(() => {
        maintaining = undefined;
      });
      return maintaining;
    },
    lost() {
      stopped = true;
      degrade();
    },
    async settled() {
      await credited.catch(() => {});
    },
    async close() {
      if (timer) clearInterval(timer);
      const wasStopped = stopped;
      stopped = true;
      degrade();
      await maintaining?.catch(() => {});
      await credited.catch(() => {}); // rounds in flight confirm (or fail) first
      // Wait (a while) for every shipped row to reach the bucket: then nothing is left to recover.
      const end = Date.now() + 10_000;
      while (pending() && Date.now() < end) await sleep(50);
      const log = o.bucket.log;
      if (!wasStopped && !pending() && log && log.state === "open" && log.epoch === epoch)
        await o.bucket.setLog({ ...log, state: "sealed" }).catch(() => {});
    },
  };
}
