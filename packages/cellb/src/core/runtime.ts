import {
  type Container,
  type ContainerEngine,
  type ContainerSpec,
  createContainer,
} from "../container.js";
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
import { type AsyncRoot, asyncRoot } from "./async-context.js";
import type { ExecutionContext } from "./durable-object.js";
import { ctxExports, type DurableObjectClass, defaultHandler, storedExports } from "./handles.js";
import { DurableObjectId, namespaceKey } from "./id.js";
import { DurableObjectNamespace, localEndpoint, type ObjectEndpoint } from "./namespace.js";
import {
  CellOwnedElsewhereError,
  closingWith,
  DurableObjectRoutingError,
  ObjectClosedError,
  ObjectHost,
} from "./object-host.js";
import { installRequestBody } from "./request-body.js";
import { type RejectionHandler, rejectionScope, reportToStderr } from "./worker-rejections.js";

export interface WorkerModule {
  /**
   * An object with handlers (`fetch(req, env, ctx)`), or a class (`export default class extends
   * WorkerEntrypoint`): an instance per request, built with `(ctx, env)`, whose `fetch(req)`
   * answers. A class matches through its `prototype`, so `default.fetch` stays readable.
   */
  default: {
    fetch?(req: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>;
    prototype?: { fetch?(req: Request): Response | Promise<Response> };
  };
  [exportName: string]: unknown;
}

export interface CellRuntimeOptions {
  /**
   * A promise the Worker's code leaves rejected (Node: the Worker shares the host's process).
   * It is the Worker's, as on workerd and celld: it reaches this handler, not the process's
   * `unhandledRejection` listeners. Default: one line on stderr, outside the Worker's console.
   */
  onUnhandledRejection?: RejectionHandler;
  /** The Worker's module namespace (what wrangler/celld bundle as main module). */
  worker: WorkerModule;
  /** Durable Object bindings: env name → exported class name (wrangler `durable_objects.bindings`). */
  durableObjects?: Record<string, { className: string }>;
  /**
   * Containers (wrangler `containers`): objects of a class in `images` get `ctx.container`, a
   * container of that image on `engine` (one per cell, kept across the object's instances,
   * destroyed after its inactivity timeout or by `close()`).
   */
  containers?: { engine: ContainerEngine; images: Record<string, ContainerSpec> };
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
  /**
   * The `ctx.id` an object sees, when it is not the id that addresses it (a facet given an `id`
   * by `ctx.facets.get`): its storage, cell key and alarms stay the addressing id's.
   */
  ctxIdOf?: (cellKey: string) => DurableObjectId | undefined;
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
  /**
   * On `close()`, how long (ms) events still running and `waitUntil` work may take to finish
   * before the databases close under them (they then fail with ObjectClosedError). Default 2000.
   */
  closeGraceMs?: number;
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
  /**
   * Runs Worker code the host dispatches itself (a cron trigger's `scheduled()`) as the Worker's
   * event: a promise it leaves rejected goes to `onUnhandledRejection`, not to the process.
   */
  runEvent<R>(fn: () => R): R;
  /** Drops live instances (simulates eviction / hibernation); storage survives if openSql persists it. */
  evictAll(): void;
  /** Settles all waitUntil() promises. */
  drain(): Promise<void>;
  /**
   * Keeps `p` running in the background until `drain()` (what `waitUntil` of
   * `cloudflare:workers` does: on Cloudflare it extends the current event).
   */
  waitUntil(p: Promise<unknown>): void;
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
  // A retired host's close() hands its cell lease back (own.json → released) with a
  // compare-and-swap. The cell's next host claims it with one too, and must not start before
  // that release lands: the two would race on the record, the claim could lose, and the cell
  // would be refused as "owned by another node" (statewalker/statewalker-root#51).
  const releasing = new Map<string, Promise<void>>();
  const retire = (cellKey: string, h = hosts.get(cellKey)) => {
    if (!h) return;
    if (hosts.get(cellKey) === h) hosts.delete(cellKey);
    const prior = releasing.get(cellKey);
    const done: Promise<void> = Promise.all([prior, h.close()]).then(() => {
      if (releasing.get(cellKey) === done) releasing.delete(cellKey);
    });
    releasing.set(cellKey, done);
  };
  const acquireAfterRelease = ownership
    ? async (key: string) => {
        await releasing.get(key);
        return ownership.tryAcquire(key);
      }
    : undefined;
  const background = new Set<Promise<unknown>>();
  // Events start in the context the runtime was made in, not their caller's (Cloudflare).
  // …and in a scope that keeps the Worker's unhandled rejections its own (Node).
  const rejections = rejectionScope(
    opts.onUnhandledRejection ?? reportToStderr(opts.scriptName ?? "worker"),
  );
  const root = asyncRoot();
  const eventsRoot: AsyncRoot = (fn) => root(() => rejections(fn));
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
        retire(e.cellKey);
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

  // ctx.container: one container per cell, kept here (not on the object), so an object's next
  // instance (after hibernation or a reset) gets the same running container, as on celld.
  const containers = new Map<string, Container>();
  const containerOf = (className: string, cellKey: string, id: DurableObjectId) => {
    const image = opts.containers?.images[className];
    if (!image || !opts.containers) return undefined;
    const engine = opts.containers.engine;
    return () => {
      let c = containers.get(cellKey);
      if (!c) {
        c = createContainer(engine, image, {
          label: id.name ?? id.toString(),
          // a closing runtime starts no container: close() would not destroy it
          refuse: () => (closed ? "the runtime is closing" : undefined),
        });
        containers.set(cellKey, c);
      }
      return c;
    };
  };

  for (const [binding, { className }] of Object.entries(opts.durableObjects ?? {})) {
    const cls = opts.worker[className] as DurableObjectClass | undefined;
    if (typeof cls !== "function")
      throw new Error(`Durable Object class "${className}" is not exported by the worker`);
    const hostFor = (id: DurableObjectId): ObjectHost => {
      const cellKey = `${className}/${id.toString()}`;
      // Once close() has closed the cells, none opens again: its storage is closed or handed to
      // the next runtime. Until then (the grace period), work in flight still reaches objects.
      if (cellsClosed) throw new ObjectClosedError(cellKey);
      let h = hosts.get(cellKey);
      if (!h || h.broken) {
        if (h) retire(cellKey, h);
        h = new ObjectHost({
          cellKey,
          id: opts.ctxIdOf?.(cellKey) ?? id,
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
          asyncRoot: eventsRoot,
          acquire: acquireAfterRelease,
          sqlExtensions: opts.sqlExtensions,
          deleteAllPreservesAlarm: opts.deleteAllPreservesAlarm,
          container: containerOf(className, cellKey, id),
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
      /** The owner's endpoint; undefined when no node owns the cell now (it can be taken here). */
      const viaOwner = async (): Promise<ObjectEndpoint | undefined> => {
        const owner = await peers.ownerOf(cellKey);
        if (!owner) return undefined;
        let direct: ObjectEndpoint | undefined;
        let link: Send;
        try {
          direct = await peers.endpoint?.(owner, cellKey, id.name);
          if (direct) return direct;
          link = peers.link(owner);
        } catch (e) {
          // The owner is named but cannot be reached (its process died, its lease still live):
          // celld's answer for the same case. The cell moves once the owner's lease expires.
          if (e instanceof DurableObjectRoutingError) throw e;
          throw new DurableObjectRoutingError(cellKey, { cause: e });
        }
        return httpEndpoint(postVia(link), codec, binding, className, id);
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
      // Drop the host whose open found the cell owned elsewhere, but only that one: by now the
      // map may hold a newer host another request opened, with events of its own queued.
      const retireBroken = () => {
        const h = hosts.get(cellKey);
        if (h?.broken) retire(cellKey, h);
      };
      /**
       * Runs an event here, or on the cell's owner. Each failed attempt was refused before the
       * event ran (the local claim lost, or the owner answered that it no longer owns the cell),
       * so it is safe to try again: locally when no node owns the cell any more, as celld
       * claims a cell whose owner's lease ran out, or on the owner the bucket names now.
       */
      const attempts = 4;
      const run = async <T>(first: ObjectEndpoint, go: (ep: ObjectEndpoint) => Promise<T>) => {
        let ep = first;
        for (let i = 1; ; i++) {
          try {
            return await go(ep);
          } catch (e) {
            if (!elsewhere(e) || i >= attempts) throw e;
            retireBroken();
            ep = (await viaOwner()) ?? local();
          }
        }
      };
      return () => {
        const l = local();
        return {
          get local() {
            return l.local; // not copied: reading it opens the cell
          },
          fetch: (req: Request) => {
            const spare = req.body ? req.clone() : req;
            let used = false;
            return run(l, (ep) => {
              const r = used ? spare.clone() : req;
              used = true;
              return ep.fetch(r);
            });
          },
          call: (method: string, args: unknown[]) => run(l, (ep) => ep.call(method, args)),
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
  /** Set by close() after its grace period: no cell opens or takes an event any more. */
  let cellsClosed = false;
  /** Aborts when close() starts: the signal of the Worker's requests in flight. */
  const closing = new AbortController();
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
      // Events in flight (a conversation's last writes, say) and waitUntil work finish first,
      // within the grace period: their writes are then in the final backups too.
      const grace = opts.closeGraceMs ?? 2_000;
      // Requests in flight, the Worker's and its objects', see their signal abort.
      closing.abort(new Error("the runtime is closing"));
      for (const h of hosts.values()) h.shutdown();
      // Work in flight may start more (a queue's delivery calls the consumer, which writes to
      // another object): wait until nothing runs, nor started while waiting, or the grace ends.
      const end = Date.now() + grace;
      for (let left = grace; left > 0; left = end - Date.now()) {
        const cells = hosts.size;
        let t: ReturnType<typeof setTimeout> | undefined;
        const idle = await Promise.race([
          Promise.all([...[...hosts.values()].map((h) => h.settled()), ...[...background]]).then(
            () => true,
          ),
          new Promise<false>((r) => (t = setTimeout(() => r(false), left))),
        ]);
        clearTimeout(t);
        if (!idle) break;
        // One more turn: what finished may have queued more work.
        await new Promise((r) => setTimeout(r, 0));
        if (
          hosts.size === cells &&
          background.size === 0 &&
          [...hosts.values()].every((h) => h.idle)
        )
          break;
      }
      cellsClosed = true;
      // A node stop destroys its containers (celld does the same): after the grace period, as
      // work in flight may still use them; none starts once closing began.
      const containersDestroyed = Promise.allSettled(
        [...containers.values()].map((c) => c.destroy()),
      );
      containers.clear();
      await backupAll("close");
      // The releases reach the store before it closes.
      for (const key of [...hosts.keys()]) retire(key);
      await Promise.all([...releasing.values()]);
      alarms.close(); // every database of the runtime is closed now
      await containersDestroyed;
      await storage.close?.();
    },
    async fetch(req) {
      const handler = defaultHandler(opts.worker.default, "fetch");
      if (!handler) return new Response("Worker has no fetch handler", { status: 500 });
      // A closed runtime serves nothing: its cells are closed, or another runtime's now.
      if (closed) return new Response("cellb: the runtime is closed", { status: 503 });
      // Its signal aborts when the runtime closes: a long poll or an SSE stream ends then.
      req = closingWith(req, closing.signal);
      const ctx = {
        waitUntil,
        passThroughOnException() {},
        exports: exportsObj,
      } as ExecutionContext;
      // celld's ingress: an inbound request has a `cf` object (no edge fields).
      if ((req as { cf?: unknown }).cf === undefined)
        Object.defineProperty(req, "cf", { value: {}, enumerable: true });
      try {
        const r = await rejections(() => handler(req, env, ctx));
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
    runEvent: (fn) => rejections(fn),
    evictAll() {
      for (const key of [...hosts.keys()]) retire(key);
    },
    async drain() {
      while (background.size) await Promise.all([...background]);
    },
    waitUntil,
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
