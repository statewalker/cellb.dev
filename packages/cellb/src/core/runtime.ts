import { type Clock, systemClock } from "../lease/lease.js";
import type { CellBackup, CellDurability, OpenCellSql, ValueCodec } from "../ports.js";
import { httpEndpoint, postVia, type Send } from "../transport/cells-http.js";
import { v8Codec } from "../v8/codec.js";
import { type CfWebSocket, takeClientPort } from "../ws/server.js";
import { withUpgrade } from "../ws/upgrade.js";
import { type AlarmEntry, AlarmScheduler } from "./alarms.js";
import { type ExecutionContext, WorkerEntrypoint } from "./durable-object.js";
import { classHandle, entrypointStub } from "./handles.js";
import { DurableObjectId, namespaceKey } from "./id.js";
import { DurableObjectNamespace, localEndpoint } from "./namespace.js";
import { CellOwnedElsewhereError, type DurableObjectClass, ObjectHost } from "./object-host.js";

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
  durability?: CellDurability;
  codec?: ValueCodec;
  /**
   * Placement: return a `send` when the cell lives elsewhere (another shard
   * worker, tab or peer); `undefined` means "host it here". Default: all local.
   */
  route?: (cellKey: string, id: DurableObjectId) => Send | undefined;
  /** The Worker script's name (wrangler `name`): object ids derive from it, as on celld. */
  scriptName?: string;
  /** Namespace keys overriding the script-scoped default, per class (celld's fleet-wide ones). */
  namespaceKeys?: Record<string, string>;
  /** Periodic backup of cell databases to a separate store (e.g. a FilesApi); restore on open. */
  backup?: CellBackup;
  /** Per-cell ownership: each object takes this lease before it opens (fencing epoch → log). */
  ownership?: {
    tryAcquire(name: string): Promise<{ epoch: number; lost: AbortSignal } | undefined>;
  };
  /**
   * Routing between nodes (celld's peer routing): when this node cannot own a cell
   * (`CellOwnedElsewhereError`), the call goes to the owner's node over an internal link
   * (`cellsHttpHandler` on the far side). `ownerOf` reads the cell's lease holder.
   */
  peers?: { ownerOf(cellKey: string): Promise<string | undefined>; link(owner: string): Send };
  /** Hibernate objects idle this long (ms); swept every max(1 s, half of it). Off by default. */
  hibernateAfterMs?: number;
  /** SQLite extensions loaded into every cell database (celld's `sqlite_vec` flag). */
  sqlExtensions?: string[];
  /** Timers of the runtime (backups); injectable for tests. */
  clock?: Clock;
}

export interface CellRuntime {
  /** Ingress: a (Request) ⇒ Response handler — exactly what webrun-http-browser / node:http mount. */
  fetch(req: Request): Promise<Response>;
  readonly env: Record<string, unknown>;
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
   */
  hibernateIdle(idleMs?: number): number;
  /** Replaces one object's instance with a fresh one on the same storage (facet abort). */
  restartObject(cellKey: string): void;
  /** Final backup of changed cells, then stops timers and closes every database. */
  close(): Promise<void>;
}

export function createCellRuntime(opts: CellRuntimeOptions): CellRuntime {
  const durability: CellDurability = opts.durability ?? { committed: () => Promise.resolve() };
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
  // ctx.exports: loopback handles of the Worker's named exports.
  const exportsObj: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(opts.worker)) {
    if (name === "default" || typeof value !== "function") continue;
    if (value.prototype instanceof WorkerEntrypoint)
      exportsObj[name] = (o: { props?: unknown } = {}) =>
        entrypointStub(value, env, o.props, exportsObj);
    else {
      // A Durable Object class: usable as a facet class handle, or called with props.
      const handle = (o: { props?: unknown } = {}) =>
        classHandle(async () => ({ cls: value as DurableObjectClass, env, props: o.props }));
      exportsObj[name] = Object.assign(
        handle,
        classHandle(async () => ({ cls: value as DurableObjectClass, env })),
      );
    }
  }
  const clock = opts.clock ?? systemClock;
  // Hosts by class name: the alarm scheduler wakes objects that nobody is calling.
  const hostsByClass = new Map<string, (id: DurableObjectId) => ObjectHost>();
  const alarms = new AlarmScheduler({
    clock,
    openIndex: () => opts.openSql("__webrun-cells/alarms"),
    fire: (e) => fireAlarm(e, 0),
  });
  const MAX_ALARM_RETRIES = 6; // as Cloudflare: exponential backoff from 2 s, then give up
  // One alarm() at a time per object (as on Cloudflare): a re-armed alarm that comes due
  // while the previous handler still runs waits for it.
  const alarmRuns = new Map<string, Promise<void>>();
  function fireAlarm(e: AlarmEntry, retryCount: number): Promise<void> {
    const prev = alarmRuns.get(e.cellKey) ?? Promise.resolve();
    const next = prev.then(() => fireAlarmNow(e, retryCount));
    alarmRuns.set(e.cellKey, next);
    void next.finally(() => {
      if (alarmRuns.get(e.cellKey) === next) alarmRuns.delete(e.cellKey);
    });
    return next;
  }
  async function fireAlarmNow(e: AlarmEntry, retryCount: number): Promise<void> {
    const hostFor = hostsByClass.get(e.className);
    if (!hostFor) return;
    const host = hostFor(new DurableObjectId(e.idHex));
    let failed = false;
    try {
      await host.deliver(async (obj, state) => {
        // The alarm is consumed when its handler starts: getAlarm() inside it returns null
        // unless the handler sets a new one.
        if (state.storage.alarmSync() === e.at) state.storage.clearAlarmSync();
        if (typeof obj.alarm === "function")
          await obj.alarm({ retryCount, isRetry: retryCount > 0 });
      });
    } catch {
      failed = true;
    }
    if (!failed || retryCount >= MAX_ALARM_RETRIES) return;
    // Retry unless the handler armed a different alarm meanwhile.
    const current = host.state.storage.alarmSync();
    if (current !== null) return;
    const retryAt = clock.now() + 2 ** (retryCount + 1) * 1000;
    clock.setTimeout(
      () => void fireAlarm({ ...e, at: retryAt }, retryCount + 1),
      retryAt - clock.now(),
    );
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
          codec,
          waitUntil,
          backup: opts.backup,
          onAlarmChange: (at) => alarms.set({ cellKey, className, idHex: id.toString() }, at),
          exports: exportsObj,
          acquire: opts.ownership ? (key) => opts.ownership!.tryAcquire(key) : undefined,
          sqlExtensions: opts.sqlExtensions,
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
      const local = localEndpoint(() => hostFor(id));
      const peers = opts.peers;
      if (!peers) return local;
      const cellKey = `${className}/${id.toString()}`;
      // Local first; a cell owned by another node is reached through that node.
      const viaOwner = async () => {
        const owner = await peers.ownerOf(cellKey);
        if (!owner) throw new CellOwnedElsewhereError(cellKey);
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
          ...l,
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
  }

  alarms.restore();
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
    if (!opts.backup || closed) return;
    timer = clock.setTimeout(() => {
      void backupAll("interval").finally(schedule);
    }, opts.backup.intervalMs ?? 30_000);
  };
  schedule();

  const runtime: CellRuntime = {
    env,
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
      for (const h of hosts.values()) if (now - h.lastActive >= idleMs && h.hibernate()) n++;
      return n;
    },
    async close() {
      if (hibernationTimer !== undefined) clock.clearTimeout(hibernationTimer);
      closed = true;
      alarms.stop();
      clock.clearTimeout(timer);
      timer = undefined;
      await backupAll("close");
      for (const h of hosts.values()) h.close();
      hosts.clear();
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
