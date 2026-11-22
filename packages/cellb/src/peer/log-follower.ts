import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStore } from "../bucket/object-store.js";

/**
 * A follower in celld's log tier (celld 0.6.3 crates/celld/node_log.rs, logic/log_tier.rs).
 *
 * In `CELLD_DURABILITY=fleet`, a celld node (the leader) ships each commit's L0 LTX segment to
 * up to two followers and acknowledges the write once every follower holds it on disk, before the
 * segment reaches the bucket. celld recruits followers among every live node record, a cellb node
 * included, so cellb serves the follower side: it stores the segments (opaque bytes, ordered by
 * the leader's sequence), answers a seal (which fences the leader's epoch for good), and hands
 * the held range back as a tail to the node that recovers a dead leader.
 *
 * Per leader session (`<node>/<generation>`) the follower keeps one fragment: the contiguous
 * range (base, end] at `fragmentEpoch`, and `sealedTo`, the highest sealed epoch. Rules:
 *   append(epoch, seq) is accepted only if epoch == fragmentEpoch, epoch > sealedTo and
 *     seq == end + 1; a new epoch is adopted only when the leader's node record names this node in
 *     an open log of that epoch, and starts at seq 1;
 *   seal(e): sealedTo = max(sealedTo, e);
 *   truncate(t) (the leader's bucket-covered watermark, carried by appends): base = max(base, t).
 * A reply leaves only after the accepted entries and the state are on disk (fsync).
 */
export interface ShipEntry {
  seq: number;
  /** The cell's scope, `<Class>:<idHex>`. */
  cell: string;
  cellEpoch: number;
  txid: number;
  /** One L0 LTX segment, verbatim. */
  bytes: Uint8Array;
}
export interface AppendRequest {
  leader: string;
  epoch: number;
  truncateTo: number;
  entries: ShipEntry[];
}
export interface AppendResp {
  ok: boolean;
  end: number;
  epoch: number;
}
export interface SealResp {
  end: number;
  base: number;
  fragment_epoch: number;
  held_fragment_epoch: number;
}
export interface Tail {
  fragmentEpoch: number;
  base: number;
  end: number;
  complete: boolean;
  entries: ShipEntry[];
}

// ---- codecs (little-endian; celld's encode_append, encode_entry, encode_tail_resp) ----------

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });
const MAGIC = { append: "CLA1", entry: "CLE1", tail2: "CLT2", tail1: "CLT1" } as const;

class Writer {
  #parts: Uint8Array[] = [];
  #size = 0;
  bytes(b: Uint8Array) {
    this.#parts.push(b);
    this.#size += b.length;
    return this;
  }
  magic(m: string) {
    return this.bytes(te.encode(m));
  }
  u8(n: number) {
    return this.bytes(Uint8Array.of(n));
  }
  u16(n: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return this.bytes(b);
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.bytes(b);
  }
  u64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return this.bytes(b);
  }
  str16(s: string) {
    const b = te.encode(s);
    return this.u16(b.length).bytes(b);
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

class Reader {
  at = 0;
  readonly #v: DataView;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
    this.#v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  #need(n: number) {
    if (this.at + n > this.b.length) throw new Error("truncated log frame");
  }
  magic(m: string) {
    this.#need(4);
    const got = String.fromCharCode(...this.b.subarray(this.at, this.at + 4));
    if (got !== m) throw new Error(`expected ${m}, got ${JSON.stringify(got)}`);
    this.at += 4;
  }
  u8() {
    this.#need(1);
    return this.b[this.at++];
  }
  u16() {
    this.#need(2);
    const v = this.#v.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32() {
    this.#need(4);
    const v = this.#v.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  u64() {
    this.#need(8);
    const v = this.#v.getBigUint64(this.at, true);
    this.at += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("u64 out of range");
    return Number(v);
  }
  bytes(n: number) {
    this.#need(n);
    const out = this.b.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  str16() {
    return td.decode(this.bytes(this.u16()));
  }
  end() {
    if (this.at !== this.b.length) throw new Error("trailing bytes after the log frame");
  }
}

const writeEntry = (w: Writer, e: ShipEntry) =>
  w
    .magic(MAGIC.entry)
    .u64(e.seq)
    .str16(e.cell)
    .u64(e.cellEpoch)
    .u64(e.txid)
    .u32(e.bytes.length)
    .bytes(e.bytes);
const readEntry = (r: Reader): ShipEntry => {
  r.magic(MAGIC.entry);
  const seq = r.u64();
  const cell = r.str16();
  const cellEpoch = r.u64();
  const txid = r.u64();
  const bytes = r.bytes(r.u32());
  return { seq, cell, cellEpoch, txid, bytes };
};

export function encodeAppend(a: AppendRequest): Uint8Array {
  const w = new Writer()
    .magic(MAGIC.append)
    .str16(a.leader)
    .u64(a.epoch)
    .u64(a.truncateTo)
    .u32(a.entries.length);
  for (const e of a.entries) writeEntry(w, e);
  return w.done();
}
export function decodeAppend(b: Uint8Array): AppendRequest {
  const r = new Reader(b);
  r.magic(MAGIC.append);
  const leader = r.str16();
  const epoch = r.u64();
  const truncateTo = r.u64();
  const n = r.u32();
  const entries: ShipEntry[] = [];
  for (let i = 0; i < n; i++) entries.push(readEntry(r));
  r.end();
  return { leader, epoch, truncateTo, entries };
}
export function encodeTail(t: Tail): Uint8Array {
  const w = new Writer()
    .magic(MAGIC.tail2)
    .u64(t.fragmentEpoch)
    .u64(t.base)
    .u64(t.end)
    .u8(t.complete ? 1 : 0)
    .u32(t.entries.length);
  for (const e of t.entries) writeEntry(w, e);
  return w.done();
}
export function decodeTail(b: Uint8Array): Tail {
  const r = new Reader(b);
  r.magic(MAGIC.tail2);
  const fragmentEpoch = r.u64();
  const base = r.u64();
  const end = r.u64();
  const complete = r.u8() === 1;
  const n = r.u32();
  const entries: ShipEntry[] = [];
  for (let i = 0; i < n; i++) entries.push(readEntry(r));
  r.end();
  return { fragmentEpoch, base, end, complete, entries };
}
const encodeTail1 = (entries: ShipEntry[]) => {
  const w = new Writer().magic(MAGIC.tail1).u32(entries.length);
  for (const e of entries) writeEntry(w, e);
  return w.done();
};

// ---- the follower --------------------------------------------------------------------------

/** celld's validate_node_name, as strict as a path segment must be. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const parseLeader = (leader: string): [string, string] => {
  const parts = leader.split("/");
  if (parts.length !== 2 || !parts.every((p) => NAME.test(p) && p !== "." && p !== ".."))
    throw new Error(`invalid leader session ${JSON.stringify(leader)}`);
  return parts as [string, string];
};

interface State {
  fragmentEpoch: number;
  base: number;
  end: number;
  sealedTo: number;
}
interface Fragment extends State {
  /** The held entries of the fragment, by seq, within (base, end]. */
  entries: Map<number, ShipEntry>;
  /** A segment file whose entries could not be read back (a torn write): the range is incomplete. */
  damaged: boolean;
}

export interface LogFollower {
  append(body: Uint8Array): Promise<AppendResp>;
  seal(req: { leader: string; epoch: number }): Promise<SealResp>;
  tail(req: { leader: string; tail_format?: number }): Promise<Uint8Array>;
  /** Drops the fragments their leader's record has closed (recovered, or a later epoch). */
  gc(): Promise<void>;
}

export function createLogFollower(opts: {
  /** A directory on a disk that keeps what was fsynced: the follower's promise to the leader. */
  dir: string;
  /** The fleet bucket: the leader's node record says whether this node is in its ensemble. */
  store: ObjectStore;
  /** This node's name in the fleet. */
  node: string;
}): LogFollower {
  const root = join(opts.dir, "peerlog");
  const fragments = new Map<string, Promise<Fragment>>();
  const locks = new Map<string, Promise<unknown>>();
  const dirOf = (node: string, gen: string) => join(root, node, gen);

  /** One leader's operations, one at a time. */
  const locked = <T>(leader: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(leader) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(
      leader,
      run.catch(() => {}),
    );
    return run;
  };

  const fsyncDir = async (dir: string) => {
    const fd = await open(dir, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  };
  /** Writes `bytes` to `file` atomically and durably: a temp file, fsync, rename, fsync dir. */
  const durableWrite = async (dir: string, file: string, bytes: Uint8Array) => {
    const tmp = join(dir, `.${file}.tmp`);
    const fd = await open(tmp, "w");
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, join(dir, file));
    await fsyncDir(dir);
  };
  const saveState = (dir: string, s: State) =>
    durableWrite(
      dir,
      "state.json",
      te.encode(
        JSON.stringify({
          fragmentEpoch: s.fragmentEpoch,
          base: s.base,
          end: s.end,
          sealedTo: s.sealedTo,
        }),
      ),
    );
  const segName = (epoch: number, first: number, last: number) =>
    `seg-${epoch}-${first}-${last}.bin`;

  const load = async (node: string, gen: string): Promise<Fragment> => {
    const dir = dirOf(node, gen);
    const f: Fragment = {
      fragmentEpoch: 0,
      base: 0,
      end: 0,
      sealedTo: 0,
      entries: new Map(),
      damaged: false,
    };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return f; // never seen: all zeros
    }
    try {
      Object.assign(f, JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State);
    } catch {
      // segments without a state: nothing they hold was acknowledged
    }
    for (const name of names) {
      const m = /^seg-(\d+)-(\d+)-(\d+)\.bin$/.exec(name);
      if (!m || Number(m[1]) !== f.fragmentEpoch) continue;
      if (Number(m[3]) <= f.base || Number(m[2]) > f.end) continue;
      try {
        const r = new Reader(new Uint8Array(await readFile(join(dir, name))));
        while (r.at < r.b.length) {
          const e = readEntry(r);
          if (e.seq > f.base && e.seq <= f.end) f.entries.set(e.seq, e);
        }
      } catch {
        f.damaged = true;
      }
    }
    return f;
  };
  const fragmentOf = (node: string, gen: string) => {
    const key = `${node}/${gen}`;
    let f = fragments.get(key);
    if (!f) {
      f = load(node, gen);
      fragments.set(key, f);
    }
    return f;
  };
  const complete = (f: Fragment) => {
    if (f.damaged) return false;
    for (let s = f.base + 1; s <= f.end; s++) if (!f.entries.has(s)) return false;
    return true;
  };
  /** Deletes the segment files wholly at or below `base`, or of another epoch. */
  const prune = async (dir: string, f: Fragment) => {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {}
    for (const name of names) {
      const m = /^seg-(\d+)-(\d+)-(\d+)\.bin$/.exec(name);
      if (m && (Number(m[1]) !== f.fragmentEpoch || Number(m[3]) <= f.base))
        await rm(join(dir, name), { force: true });
    }
    for (const s of f.entries.keys()) if (s <= f.base) f.entries.delete(s);
  };

  /** The leader's record names this node in an open log of `epoch`, for this generation. */
  const adoptable = async (node: string, gen: string, epoch: number) => {
    const o = await opts.store.get(`nodes/${node}.json`);
    if (!o) return false;
    const rec = JSON.parse(new TextDecoder().decode(o.body)) as {
      ownership_index_generation?: string;
      probe_public_key?: string;
      log?: { state?: string; epoch?: number; ensemble?: string[] };
    };
    const generation = rec.ownership_index_generation || rec.probe_public_key;
    return (
      generation === gen &&
      rec.log?.epoch === epoch &&
      rec.log.state === "open" &&
      !!rec.log.ensemble?.includes(opts.node)
    );
  };

  const reply = (f: State, ok: boolean): AppendResp => ({ ok, end: f.end, epoch: f.fragmentEpoch });

  return {
    async append(body) {
      const req = decodeAppend(body);
      const [node, gen] = parseLeader(req.leader);
      return locked(req.leader, async () => {
        const f = await fragmentOf(node, gen);
        const dir = dirOf(node, gen);
        const frameLast = req.entries.at(-1)?.seq ?? 0;
        if (req.epoch !== f.fragmentEpoch) {
          // A new epoch of this leader: only one the leader's record says this node follows.
          if (
            !req.entries.length ||
            req.epoch <= f.sealedTo ||
            req.epoch < f.fragmentEpoch ||
            req.entries[0].seq !== 1 ||
            !(await adoptable(node, gen, req.epoch))
          )
            return reply(f, false);
          await mkdir(dir, { recursive: true });
          Object.assign(f, { fragmentEpoch: req.epoch, base: 0, end: 0, damaged: false });
          f.entries.clear();
          await prune(dir, f);
          await saveState(dir, f);
        }
        if (f.fragmentEpoch <= f.sealedTo) return reply(f, false); // sealed: never again
        // Entries the follower holds already (a hedged copy) are skipped; the rest must follow on.
        const accepted: ShipEntry[] = [];
        let next = f.end + 1;
        for (const e of req.entries) {
          if (e.seq < next) continue;
          if (e.seq !== next) break;
          accepted.push(e);
          next++;
        }
        const newEnd = next - 1;
        const firstAccepted = accepted[0]?.seq;
        const truncateTo = Math.min(
          req.truncateTo,
          firstAccepted !== undefined ? firstAccepted - 1 : req.truncateTo,
          newEnd,
        );
        const newBase = Math.max(f.base, truncateTo);
        if (!accepted.length && newBase === f.base) return reply(f, f.end >= frameLast);
        try {
          await mkdir(dir, { recursive: true });
          if (accepted.length) {
            const w = new Writer();
            for (const e of accepted) writeEntry(w, e);
            await durableWrite(dir, segName(f.fragmentEpoch, accepted[0].seq, newEnd), w.done());
          }
          await saveState(dir, { ...f, end: newEnd, base: newBase });
        } catch {
          return reply(f, false); // not on disk: nothing is confirmed
        }
        for (const e of accepted) f.entries.set(e.seq, e);
        f.end = newEnd;
        if (newBase !== f.base) {
          f.base = newBase;
          await prune(dir, f).catch(() => {});
        }
        return reply(f, f.end >= frameLast);
      });
    },

    async seal(req) {
      const [node, gen] = parseLeader(req.leader);
      return locked(req.leader, async () => {
        const f = await fragmentOf(node, gen);
        const dir = dirOf(node, gen);
        if (req.epoch > f.sealedTo) {
          await mkdir(dir, { recursive: true });
          await saveState(dir, { ...f, sealedTo: req.epoch });
          f.sealedTo = req.epoch;
        }
        return {
          end: f.end,
          base: f.base,
          fragment_epoch: complete(f) ? f.fragmentEpoch : 0,
          held_fragment_epoch: f.fragmentEpoch,
        };
      });
    },

    async tail(req) {
      const [node, gen] = parseLeader(req.leader);
      return locked(req.leader, async () => {
        const f = await fragmentOf(node, gen);
        const entries = [...f.entries.values()]
          .filter((e) => e.seq > f.base && e.seq <= f.end)
          .sort((a, b) => a.seq - b.seq);
        const whole = complete(f);
        if ((req.tail_format ?? 1) !== 2) {
          if (!whole) throw new Error("the retained range is not complete");
          return encodeTail1(entries);
        }
        return encodeTail({
          fragmentEpoch: f.fragmentEpoch,
          base: f.base,
          end: f.end,
          complete: whole,
          entries,
        });
      });
    },

    async gc() {
      let nodes: string[] = [];
      try {
        nodes = await readdir(root);
      } catch {
        return;
      }
      for (const node of nodes.filter((n) => NAME.test(n))) {
        const o = await opts.store.get(`nodes/${node}.json`).catch(() => undefined);
        if (!o) continue; // no record: keep what is held (celld never deletes a record with a log)
        const log = (
          JSON.parse(new TextDecoder().decode(o.body)) as {
            log?: { state?: string; epoch?: number };
          }
        ).log;
        if (!log || typeof log.epoch !== "number") continue;
        for (const gen of (await readdir(join(root, node))).filter((g) => NAME.test(g))) {
          await locked(`${node}/${gen}`, async () => {
            const f = await fragmentOf(node, gen);
            const closed =
              log.epoch! > f.fragmentEpoch ||
              (log.epoch === f.fragmentEpoch && log.state === "sealed");
            if (!closed || (f.base === f.end && f.sealedTo >= f.fragmentEpoch)) return;
            const dir = dirOf(node, gen);
            const s = { ...f, base: f.end, sealedTo: Math.max(f.sealedTo, f.fragmentEpoch) };
            await saveState(dir, s);
            f.base = s.base;
            f.sealedTo = s.sealedTo;
            await prune(dir, f);
          });
        }
      }
    },
  };
}
