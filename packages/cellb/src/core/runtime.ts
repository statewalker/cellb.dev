import {
  type CellDurability,
  type CellStorage,
  type Clock,
  type OpenCellSql,
  systemClock,
  type ValueCodec,
} from "../ports.js";
import { httpEndpoint, postVia, type Send } from "../transport/cells-link.js";
import { v8Codec, v8CodecWith } from "../v8/codec.js";
import { type CfWebSocket, takeClientPort } from "../ws/server.js";
import { withUpgrade } from "../ws/upgrade.js";
import { type AlarmEntry, AlarmScheduler } from "./alarms.js";
import type { ExecutionContext } from "./durable-object.js";
import { ctxExports, type DurableObjectClass, storedExports } from "./handles.js";
import { DurableObjectId, namespaceKey } from "./id.js";
import { DurableObjectNamespace, localEndpoint, type ObjectEndpoint } from "./namespace.js";
import { CellOwnedElsewhereError, ObjectHost } from "./object-host.js";
import { installRequestBody } from "./request-body.js";

export interface WorkerModule {
  default: { fetch?(req: Request, env: any, ctx: ExecutionContext): Response | Promise<Response> };
  [exportName: string]: unknown;
}

export interface CellRuntimeOptions {
  /** The Worker's module namespace (what wrangler/celld bundle as main module). */
  worker: WorkerModule;
  /** Durable Object bindings: env name → exported class name (wrangler `durable_objects.bindings`). */
  durableObjects?: Record<string, { className: string }>;
  /** Plain vars / other bindings merged into env. */
  vars?: Record<string, unknown>;
  openSql: OpenCellSql;
  /** Durability, backup and ownership of the cells; closed by `close()`, after the runtime. */
  storage?: CellStorage;
  codec?: ValueCodec;
  /**
   * Placement: return a `send` when the cell lives elsewhere (another shard
   * worker, tab or peer); `undefined` means "host it here". Default: all local.
   */
  route?: (cellKey: string, id: DurableObjectId) => Send | undefined;
  /** How often to re-read a shared alarm wake index (durability.wakes), in ms. Default 30 s. */
  wakePollMs?: number;
  /** Every object of this runtime is a facet of an outer cell (an isolate's runtime). */
  facets?: boolean;
  /** The Worker script's name (wrangler `name`): object ids derive from it, as on celld. */
  scriptName?: string;
  /** Namespace keys overriding the script-scoped default, per class (celld's fleet-wide ones). */
  namespaceKeys?: Record<string, string>;
  /**
   * Routing between nodes (celld's peer routing): when this node cannot own a cell
   * (`CellOwnedElsewhereError`), the call goes to the owner's node over an internal link
   * (`cellsHttpHandler` on the far side). `ownerOf` reads the cell's lease holder.
   */
  peers?: {
    ownerOf(cellKey: string): Promise<string | undefined>;
    link(owner: string): Send;
    /**
     * Talks to an owner directly, for owners that do not speak cellsHttpHandler (a celld node,
     * reached through celld's peer tunnel). Takes precedence over `link` when it returns one.
     */
    endpoint?(
      owner: string,
      cellKey: string,
      name: string | undefined,
    ): Promise<ObjectEndpoint | undefined>;
  };
  /** Hibernate objects idle this long (ms); swept every max(1 s, half of it). Off by default. */
  hibernateAfterMs?: number;
  /**
   * Close the SQLite database of a hibernated object idle this long (ms); the next event reopens
   * it. Swept with `hibernateAfterMs`, so it needs that too. Off by default: the database must
   * come back, so use local SQLite that persists (a directory, an OPFS pool) or storage that
   * restores the cell (a log or a backup).
   */
  closeDatabaseAfterMs?: number;
  /** SQLite extensions loaded into every cell database (celld's `sqlite_vec` flag). */
  sqlExtensions?: string[];
  /** `delete_all_preserves_alarm`: storage.deleteAll() keeps the alarm (default: deletes it). */
  deleteAllPreservesAlarm?: boolean;
  /** Timers of the runtime (backups); injectable for tests. */
  clock?: Clock;
}

export interface CellRuntime {
  /** Ingress: a (Request) ⇒ Response handler — exactly what webrun-http-browser / node:http mount. */
  fetch(req: Request): Promise<Response>;
  readonly env: Record<string, unknown>;
  /** The Worker's `ctx.exports` (also `exports` of `cloudflare:workers`). */
  readonly exports: Record<string, unknown>;
  /** Drops live instances (simulates eviction / hibernation); storage survives if openSql persists it. */
  evictAll(): void;
  /** Settles all waitUntil() promises. */
  drain(): Promise<void>;
  /** Durable Object binding → class name (the namespace key used by idFromName). */
  readonly durableObjectBindings: Readonly<Record<string, string>>;
  /**
   * WebSocket ingress: runs the Worker's fetch with an Upgrade request; on a 101
   * with `webSocket`, returns the client end's MessagePort (to be transferred to
   * the real client, e.g. a page's CellsWebSocket).
   */
  connectWebSocket(
    url: string,
    protocols?: string[],
    headers?: HeadersInit,
  ): Promise<{ port: MessagePort; protocol?: string }>;
  /** Backs up every live cell that changed since its last successful save. */
  backupNow(): Promise<void>;
  /**
   * Hibernates every object idle for at least `idleMs` (default: `hibernateAfterMs`):
   * instances are dropped, storage and hibernatable WebSockets stay. Returns how many slept.
   * Hibernated objects idle for `closeDatabaseAfterMs` also close their database.
   */
  hibernateIdle(idleMs?: number): number;
  /** Replaces one object's instance with a fresh one on the same storage (facet abort). */
  restartObject(cellKey: string): void;
  /** Final backup of changed cells, then stops timers, closes every database and the storage. */
  close(): Promise<void>;
}

export function createCellRuntime(opts: CellRuntimeOptions): CellRuntime {
  installRequestBody(); // Firefox: `request.body` for the Worker code (and for the retry below)
  const storage = opts.storage ?? {};
  const { backup, ownership } = storage;
  const durability: CellDurability = storage.durability ?? { committed: () => Promise.resolve() };
  // V8 serialization: storage values in celld's (and workerd's) format.
  const codec = opts.codec ?? v8Codec;
  const hosts = new Map<string, ObjectHost>();
  const background = new Set<Promise<unknown>>();
  const waitUntil = (p: Promise<unknown>) => {
    const t = p.catch(() => {}).finally(() => background.delete(t));
    background.add(t);
  };
  const env: Record<string, unknown> = { ...opts.vars };
  const bindingClasses: Record<string, string> = {};
  const exportsObj = ctxExports(opts.worker, env);
  // Storage values: V8 serialization; ctx.exports stubs are stored too (workerd).
  const storageCodec = opts.codec ?? v8CodecWith(storedExports(exportsObj));
  const clock = opts.clock ?? systemClock;
  // Hosts by class name: the alarm scheduler wakes objects that nobody is calling.
  const hostsByClass = new Map<string, (id: DurableObjectId) => ObjectHost>();
  const alarms = new AlarmScheduler({
    clock,
    openIndex: () => opts.openSql("__cellb/alarms"),
    fire: (e) => fireAlarm(e),
  });
  // One alarm() at a time per object (as on Cloudflare): a re-armed alarm that comes due
  // while the previous handler still runs waits for it.
  const alarmRuns = new Map<string, Promise<void>>();
  const ownedRetries = new Map<string, number>();
  function fireAlarm(e: AlarmEntry): Promise<void> {
    const prev = alarmRuns.get(e.cellKey) ?? Promise.resolve();
    const next = prev.then(() => fireAlarmNow(e));
    alarmRuns.set(e.cellKey, next);
    void next.finally(() => {
      if (alarmRuns.get(e.cellKey) === next) alarmRuns.delete(e.cellKey);
    });
    return next;
  }
  /**
   * celld's alarm lifecycle, in the cell's own storage (so it survives restarts and moves
   * between nodes, celld included): the row stays while its handler runs (getAlarm() reads
   * null meanwhile); success deletes it, failure reschedules it with backoff and counts the
   * failure in the row (`retry`, `counted_retry`) — alarmInfo.retryCount is that count.
   */
  async function fireAlarmNow(e: AlarmEntry): Promise<void> {
    const hostFor = hostsByClass.get(e.className);
    if (!hostFor) return;
    const host = hostFor(new DurableObjectId(e.idHex));
    try {
      await host.deliver(async (obj, state) => {
        // A wake (local timer, or an entry of the shared wake index) is a hint: the stored
        // alarm decides. Gone → nothing to do; moved later → wait for that time.
        const row = state.storage.alarmRowSync();
        if (!row) return;
        if (row.at > clock.now()) {
          alarms.set(e, row.at);
          return;
        }
        state.storage.beginAlarm(row);
        let ok = true;
        try {
          if (typeof obj.alarm === "function")
            await obj.alarm({
              retryCount: row.retry,
              isRetry: row.retry > 0,
              scheduledTime: row.at, // alarmInfo.scheduledTime, as in workerd
            });
        } catch {
          ok = false;
        }
        state.storage.finishAlarm(row, ok, clock.now());
      });
      ownedRetries.delete(e.cellKey);
    } catch (err) {
      // Owned by another node (celld or cellb): its owner fires the alarm.
      if (isOwnedElsewhere(err)) {
        hosts.get(e.cellKey)?.close();
        hosts.delete(e.cellKey);
        // A live owner fires it. A stopped one's lease expires within its TTL: look again a
        // few times before leaving it to the next poll of the wake index.
        const n = (ownedRetries.get(e.cellKey) ?? 0) + 1;
        if (n <= 15) {
          ownedRetries.set(e.cellKey, n);
          alarms.set(e, clock.now() + 2_000);
        } else ownedRetries.delete(e.cellKey);
      }
      // Any other failure (broken object, storage error): the row is unchanged; it fires again
      // when the object is next opened or the index is polled.
    }
  }

  for (const [binding, { className }] of Object.entries(opts.durableObjects ?? {})) {
    const cls = opts.worker[className] as DurableObjectClass | undefined;
    if (typeof cls !== "function")
      throw new Error(`Durable Object class "${className}" is not exported by the worker`);
    const hostFor = (id: DurableObjectId): ObjectHost => {
      const cellKey = `${className}/${id.toString()}`;
      let h = hosts.get(cellKey);
      if (!h || h.broken) {
        h?.close();
        h = new ObjectHost({
          cellKey,
          id,
          cls,
          env,
          openSql: opts.openSql,
          durability,
          codec: storageCodec,
          waitUntil,
          backup,
          onAlarmChange: (at) => alarms.set({ cellKey, className, idHex: id.toString() }, at),
          exports: exportsObj,
          facet: opts.facets,
          acquire: ownership ? (key) => ownership.tryAcquire(key) : undefined,
          sqlExtensions: opts.sqlExtensions,
          deleteAllPreservesAlarm: opts.deleteAllPreservesAlarm,
        });
        hosts.set(cellKey, h);
      }
      return h;
    };
    hostsByClass.set(className, hostFor);
    const nsKey =
      opts.namespaceKeys?.[className] ?? namespaceKey(opts.scriptName ?? "worker", className);
    env[binding] = new DurableObjectNamespace(nsKey, (id) => {
      const remote = opts.route?.(`${className}/${id.toString()}`, id);
      if (remote) return () => httpEndpoint(postVia(remote), codec, binding, className, id);
      const cellKey = `${className}/${id.toString()}`;
      // A cell not open yet waits for room in its store before its first event (OPFS pool).
      const ready = () => (hosts.has(cellKey) ? undefined : opts.openSql.room?.(cellKey));
      const local = localEndpoint(() => hostFor(id), ready);
      const peers = opts.peers;
      if (!peers) return local;
      // Local first; a cell owned by another node is reached through that node.
      const viaOwner = async () => {
        const owner = await peers.ownerOf(cellKey);
        if (!owner) throw new CellOwnedElsewhereError(cellKey);
        const direct = await peers.endpoint?.(owner, cellKey, id.name);
        if (direct) return direct;
        return httpEndpoint(postVia(peers.link(owner)), codec, binding, className, id);
      };
      // The host reports a failed open as a broken object; the cause tells why.
      const elsewhere = (e: unknown): boolean => {
        for (
          let x = e as { name?: string; cause?: unknown } | undefined, i = 0;
          x && i < 5;
          x = x.cause as never, i++
        )
          if (x.name === "CellOwnedElsewhereError") return true;
        return false;
      };
      return () => {
        const l = local();
        return {
          get local() {
            return l.local; // not copied: reading it opens the cell
          },
          fetch: async (req: Request) => {
            const spare = req.body ? req.clone() : req;
            try {
              return await l.fetch(req);
            } catch (e) {
              if (!elsewhere(e)) throw e;
              hosts.get(cellKey)?.close();
              hosts.delete(cellKey);
              return (await viaOwner()).fetch(spare);
            }
          },
          call: async (method: string, args: unknown[]) => {
            try {
              return await l.call(method, args);
            } catch (e) {
              if (!elsewhere(e)) throw e;
              hosts.get(cellKey)?.close();
              hosts.delete(cellKey);
              return (await viaOwner()).call(method, args);
            }
          },
        };
      };
    });
    bindingClasses[binding] = className;
    // ctx.exports.<Class> of a class with a namespace is also that namespace, as in workerd
    // (`ctx.exports.MyActor.getByName("a")`); it stays usable as a facet class handle.
    const ns = env[binding] as DurableObjectNamespace;
    const exported = exportsObj[className] as Record<string, unknown> | undefined;
    if (exported && !("getByName" in exported))
      for (const [m, d] of Object.entries(
        Object.getOwnPropertyDescriptors(DurableObjectNamespace.prototype),
      ))
        if (m !== "constructor" && typeof d.value === "function") exported[m] = d.value.bind(ns);
  }

  alarms.restore();
  // Alarms published by any node in a shared wake index (celld's): this node fires them too.
  // An entry is only a hint: firing opens the cell and runs alarm() only if its stored alarm
  // is still due at that time.
  // The index is read at start and then every `wakePollMs` (default 30 s), so alarms of cells
  // whose owner went away are picked up — celld's waker does the same.
  const wakes = storage.durability?.wakes;
  let wakeTimer: unknown;
  let wakesStopped = false;
  if (wakes) {
    const known = new Set(Object.values(bindingClasses));
    const poll = async () => {
      try {
        for (const w of await wakes.call(storage.durability))
          if (known.has(w.className) && !alarmRuns.has(w.cellKey))
            alarms.set(
              { cellKey: w.cellKey, className: w.className, idHex: w.cellKey.split("/")[1] },
              w.at,
            );
      } catch {
        // the index is unavailable for now: next poll
      }
      if (!wakesStopped) wakeTimer = clock.setTimeout(() => void poll(), opts.wakePollMs ?? 30_000);
    };
    void poll();
  }
  // Idle sweep for hibernation (opt-in).
  let hibernationTimer: unknown;
  if (opts.hibernateAfterMs !== undefined) {
    const every = Math.max(1_000, opts.hibernateAfterMs / 2);
    const sweep = () => {
      runtime.hibernateIdle();
      hibernationTimer = clock.setTimeout(sweep, every);
    };
    hibernationTimer = clock.setTimeout(sweep, every);
  }
  const backupAll = (reason: "interval" | "manual" | "close") =>
    Promise.all([...hosts.values()].map((h) => h.backupIfDirty(reason, clock.now()))).then(
      () => {},
    );
  let timer: unknown;
  let closed = false;
  const schedule = () => {
    if (!backup || closed) return;
    timer = clock.setTimeout(() => {
      void backupAll("interval").finally(schedule);
    }, backup.intervalMs ?? 30_000);
  };
  schedule();

  const runtime: CellRuntime = {
    env,
    exports: exportsObj,
    durableObjectBindings: bindingClasses,
    backupNow: () => backupAll("manual"),
    async connectWebSocket(url, protocols = [], headers) {
      const h = new Headers(headers);
      h.set("Upgrade", "websocket");
      if (protocols.length) h.set("Sec-WebSocket-Protocol", protocols.join(", "));
      const httpUrl = url.replace(/^ws(s?):/, "http$1:");
      const res = (await this.fetch(
        withUpgrade(
          new Request(httpUrl, { headers: h }),
          "websocket",
          protocols.length ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : undefined,
        ),
      )) as Response & {
        webSocket?: CfWebSocket | null;
      };
      if (res.status !== 101 || !res.webSocket)
        throw new Error(`WebSocket upgrade refused: HTTP ${res.status}`);
      return {
        port: takeClientPort(res.webSocket),
        protocol: res.headers.get("Sec-WebSocket-Protocol") ?? undefined,
      };
    },
    restartObject(cellKey: string) {
      hosts.get(cellKey)?.restart();
    },
    hibernateIdle(idleMs = opts.hibernateAfterMs ?? 0) {
      const now = Date.now();
      let n = 0;
      const closeMs = opts.closeDatabaseAfterMs;
      for (const h of hosts.values()) {
        const idle = now - h.lastActive;
        if (idle >= idleMs && h.hibernate()) n++;
        if (closeMs !== undefined && idle >= closeMs) h.closeDatabase();
      }
      return n;
    },
    async close() {
      if (hibernationTimer !== undefined) clock.clearTimeout(hibernationTimer);
      closed = true;
      wakesStopped = true;
      if (wakeTimer !== undefined) clock.clearTimeout(wakeTimer);
      alarms.stop();
      clock.clearTimeout(timer);
      timer = undefined;
      await backupAll("close");
      // The releases reach the store before it closes.
      await Promise.all([...hosts.values()].map((h) => h.close()));
      hosts.clear();
      await storage.close?.();
    },
    async fetch(req) {
      const handler = opts.worker.default?.fetch;
      if (!handler) return new Response("Worker has no fetch handler", { status: 500 });
      const ctx = {
        waitUntil,
        passThroughOnException() {},
        exports: exportsObj,
      } as ExecutionContext;
      // celld's ingress: an inbound request has a `cf` object (no edge fields).
      if ((req as { cf?: unknown }).cf === undefined)
        Object.defineProperty(req, "cf", { value: {}, enumerable: true });
      try {
        const r = await handler.call(opts.worker.default, req, env, ctx);
        // A non-Response is sent as text (celld), not a failure.
        return r instanceof Response ? r : new Response(String(r));
      } catch (e) {
        const err = e as Error;
        return new Response(
          `Worker failed: rejected: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`,
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
    },
    evictAll() {
      for (const h of hosts.values()) h.close();
      hosts.clear();
    },
    async drain() {
      while (background.size) await Promise.all([...background]);
    },
  };
  return runtime;
}

/** The error (or its cause chain) says another node owns the cell. */
export function isOwnedElsewhere(e: unknown): boolean {
  for (
    let x = e as { name?: string; cause?: unknown } | undefined, i = 0;
    x && i < 5;
    x = x.cause as never, i++
  )
    if (x.name === "CellOwnedElsewhereError") return true;
  return false;
}
