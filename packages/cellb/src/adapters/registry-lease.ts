import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Clock, type Lease, type LeaseHandle, systemClock } from "../lease/lease.js";

export interface RegistryLeaseOptions {
  /** Registry root shared by all processes (Miniflare: ~/.wrangler/registry). */
  dir: string;
  /** Identity of this process/instance. */
  candidateId: string;
  /** Heartbeat period — mtime touch (Miniflare storage candidates: 2 s). */
  heartbeatMs?: number;
  /** A candidate whose mtime is older than this is dead (Miniflare: 10 s). */
  staleMs?: number;
  clock?: Clock;
}

interface Entry {
  candidateId: string;
  registeredAt: number;
  pid: number;
}

/**
 * Server-side ownership in the style of Miniflare 4's dev registry
 * ("storage candidates"): every process registers a candidate file per shard
 * and touches its mtime as a heartbeat; the OLDEST LIVE candidate owns the shard;
 * stale entries are deleted by whoever notices them; a graceful release stops
 * serving before withdrawing the entry.
 *
 * Like Miniflare, there is NO fencing: a process paused longer than `staleMs`
 * may briefly believe it still owns. On one host pair it with
 * `nodeSqliteOpener(dir, { exclusive: true })` — the OS file lock then fences
 * the cell storage itself. `epoch` is the owner's registration time (unique,
 * not monotonic across failovers).
 */
export class RegistryLease implements Lease {
  readonly #o: Required<RegistryLeaseOptions>;
  readonly #registered = new Map<string, { entry: Entry; timer: unknown }>();

  constructor(opts: RegistryLeaseOptions) {
    this.#o = { heartbeatMs: 2_000, staleMs: 10_000, clock: systemClock, ...opts };
  }

  async tryAcquire(name: string): Promise<LeaseHandle | undefined> {
    const reg = this.#register(name);
    return this.#isOwner(name, reg.entry) ? this.#handle(name, reg.entry) : undefined;
  }

  /** Withdraws this process's candidacy for `name` (no-op if not registered). */
  withdraw(name: string): void {
    const reg = this.#registered.get(name);
    if (!reg) return;
    this.#o.clock.clearTimeout(reg.timer);
    this.#registered.delete(name);
    rmSync(this.#file(name, reg.entry.candidateId), { force: true });
  }

  /** Live candidates of a shard, oldest first (diagnostics / routing). */
  candidates(name: string): Entry[] {
    const dir = this.#dir(name);
    const now = this.#o.clock.now();
    const live: Entry[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      const path = join(dir, f);
      try {
        const age = now - statSync(path).mtimeMs;
        const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
        if (age > this.#o.staleMs) {
          if (entry.candidateId !== this.#o.candidateId) rmSync(path, { force: true }); // stale cleanup
          continue;
        }
        live.push(entry);
      } catch {
        /* concurrently removed or half-written: ignore */
      }
    }
    return live.sort(
      (a, b) => a.registeredAt - b.registeredAt || a.candidateId.localeCompare(b.candidateId),
    );
  }

  #dir(name: string): string {
    return join(this.#o.dir, name.replace(/[^\w.-]/g, "_"));
  }
  #file(name: string, candidateId: string): string {
    return join(this.#dir(name), `${candidateId.replace(/[^\w.-]/g, "_")}.json`);
  }
  #touch(path: string): void {
    const t = this.#o.clock.now() / 1000;
    utimesSync(path, t, t);
  }

  #register(name: string) {
    const known = this.#registered.get(name);
    if (known) return known;
    mkdirSync(this.#dir(name), { recursive: true });
    const entry: Entry = {
      candidateId: this.#o.candidateId,
      registeredAt: this.#o.clock.now(),
      pid: process.pid,
    };
    const path = this.#file(name, entry.candidateId);
    writeFileSync(path, JSON.stringify(entry));
    this.#touch(path);
    const reg = { entry, timer: undefined as unknown };
    const beat = () => {
      try {
        // Miniflare: "if the entry is missing, the owner recreates it" — for a
        // candidate that is fine; an OWNER finding its entry gone must step down
        // (see #handle), so the heartbeat only touches an existing file.
        statSync(path);
        this.#touch(path);
      } catch {
        // Deleted as stale while we were paused: come back as a NEW (youngest) candidate.
        entry.registeredAt = this.#o.clock.now();
        writeFileSync(path, JSON.stringify(entry));
        this.#touch(path);
      }
      reg.timer = this.#o.clock.setTimeout(beat, this.#o.heartbeatMs);
    };
    reg.timer = this.#o.clock.setTimeout(beat, this.#o.heartbeatMs);
    this.#registered.set(name, reg);
    return reg;
  }

  #isOwner(name: string, entry: Entry): boolean {
    const [oldest] = this.candidates(name);
    return oldest?.candidateId === entry.candidateId && oldest.registeredAt === entry.registeredAt;
  }

  #handle(name: string, entry: Entry): LeaseHandle {
    const ac = new AbortController();
    const registeredAt = entry.registeredAt; // the ownership we were granted
    const path = this.#file(name, entry.candidateId);
    let timer: unknown;
    const check = () => {
      if (ac.signal.aborted) return;
      let ok = false;
      try {
        const mine = JSON.parse(readFileSync(path, "utf8")) as Entry;
        // Our entry was deleted as stale (we were paused) and maybe re-created: the
        // registration changed → someone may have owned the shard meanwhile.
        ok = mine.registeredAt === registeredAt && this.#isOwner(name, mine);
      } catch {
        ok = false;
      }
      if (!ok) return ac.abort(new Error(`registry lease "${name}" lost`));
      timer = this.#o.clock.setTimeout(check, this.#o.heartbeatMs);
    };
    timer = this.#o.clock.setTimeout(check, this.#o.heartbeatMs);
    return {
      name,
      epoch: registeredAt,
      lost: ac.signal,
      release: async () => {
        // Graceful disposal: stop serving first, then withdraw the entry.
        this.#o.clock.clearTimeout(timer);
        if (!ac.signal.aborted) ac.abort(new Error("released"));
        this.withdraw(name);
      },
    };
  }
}
