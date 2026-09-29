import { type Clock, systemClock } from "../lease/lease.js";
import type { CellBackup, CellDurability, OpenCellSql, ValueCodec } from "../ports.js";
import { httpEndpoint, postVia, type Send } from "../transport/cells-http.js";
import { type CfWebSocket, takeClientPort } from "../ws/server.js";
import { withUpgrade } from "../ws/upgrade.js";
import { jsonCodec } from "./codec.js";
import type { ExecutionContext } from "./durable-object.js";
import type { DurableObjectId } from "./id.js";
import { DurableObjectNamespace, localEndpoint } from "./namespace.js";
import { type DurableObjectClass, ObjectHost } from "./object-host.js";

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
  /** Periodic backup of cell databases to a separate store (e.g. a FilesApi); restore on open. */
  backup?: CellBackup;
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
  /** Final backup of changed cells, then stops timers and closes every database. */
  close(): Promise<void>;
}

export function createCellRuntime(opts: CellRuntimeOptions): CellRuntime {
  const durability: CellDurability = opts.durability ?? { committed: () => Promise.resolve() };
  const codec = opts.codec ?? jsonCodec;
  const hosts = new Map<string, ObjectHost>();
  const background = new Set<Promise<unknown>>();
  const waitUntil = (p: Promise<unknown>) => {
    const t = p.catch(() => {}).finally(() => background.delete(t));
    background.add(t);
  };
  const env: Record<string, unknown> = { ...opts.vars };
  const bindingClasses: Record<string, string> = {};

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
        });
        hosts.set(cellKey, h);
      }
      return h;
    };
    env[binding] = new DurableObjectNamespace(className, (id) => {
      const remote = opts.route?.(`${className}/${id.toString()}`, id);
      return remote
        ? () => httpEndpoint(postVia(remote), codec, binding, className, id)
        : localEndpoint(() => hostFor(id));
    });
    bindingClasses[binding] = className;
  }

  const clock = opts.clock ?? systemClock;
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

  return {
    env,
    durableObjectBindings: bindingClasses,
    backupNow: () => backupAll("manual"),
    async connectWebSocket(url, protocols = [], headers) {
      const h = new Headers(headers);
      h.set("Upgrade", "websocket");
      if (protocols.length) h.set("Sec-WebSocket-Protocol", protocols.join(", "));
      const httpUrl = url.replace(/^ws(s?):/, "http$1:");
      const res = (await this.fetch(
        withUpgrade(new Request(httpUrl, { headers: h })),
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
    async close() {
      closed = true;
      clock.clearTimeout(timer);
      timer = undefined;
      await backupAll("close");
      for (const h of hosts.values()) h.close();
      hosts.clear();
    },
    async fetch(req) {
      const handler = opts.worker.default?.fetch;
      if (!handler) return new Response("Worker has no fetch handler", { status: 500 });
      const ctx: ExecutionContext = { waitUntil, passThroughOnException() {} };
      try {
        return await handler.call(opts.worker.default, req, env, ctx);
      } catch (e) {
        return new Response(String((e as Error)?.stack ?? e), { status: 500 });
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
}
