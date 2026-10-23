import type { FilesApi } from "@statewalker/webrun-files";
import { type AssetFiles, type AssetsConfig, createAssets } from "../bindings/assets.js";
import { celldKv } from "../bindings/celld-kv.js";
import { celldQueues } from "../bindings/celld-queues.js";
import { celldWorkflows } from "../bindings/celld-workflows.js";
import { startCronTriggers } from "../bindings/cron.js";
import {
  makeQueueCell,
  type QueueConsumerConfig,
  type QueueDispatcher,
  queueProducer,
} from "../bindings/queues.js";
import { r2Bucket, r2BucketOn } from "../bindings/r2.js";
import { celldR2Backend } from "../bindings/r2-celld.js";
import { type ModuleLoader, workerLoader } from "../bindings/worker-loader.js";
import { makeWorkflowCell, type WorkflowConfig, workflowBinding } from "../bindings/workflows.js";
import { entrypointStub } from "../core/handles.js";
import type { DurableObjectNamespace } from "../core/namespace.js";
import {
  type CellRuntime,
  type CellRuntimeOptions,
  createCellRuntime,
  type WorkerModule,
} from "../core/runtime.js";
import { splitSqlStatements } from "../core/sql-split.js";
import { systemClock } from "../lease/lease.js";
import { filesApiBlobService } from "../miniflare-compat/blob-service.js";
import { simulatorFetcher } from "../miniflare-compat/simulator-fetcher.js";
import { D1DatabaseObject, makeD1Binding } from "../miniflare-compat/vendored.js";

/** The subset of wrangler.json(c) that celld deploys (and webrun-cells reads). */
export interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  vars?: Record<string, unknown>;
  durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
  migrations?: {
    tag: string;
    new_sqlite_classes?: string[];
    new_classes?: string[];
    renamed_classes?: { from: string; to: string }[];
    deleted_classes?: string[];
  }[];
  kv_namespaces?: { binding: string; id: string }[];
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  queues?: {
    producers?: { binding: string; queue: string; delivery_delay?: number }[];
    consumers?: QueueConsumerConfig[];
  };
  workflows?: WorkflowConfig[];
  triggers?: { crons?: string[] };
  assets?: AssetsConfig;
  services?: { binding: string; service: string; entrypoint?: string; props?: unknown }[];
  worker_loaders?: { binding: string }[];
}

export interface ProjectHost
  extends Pick<
    CellRuntimeOptions,
    "openSql" | "durability" | "backup" | "clock" | "ownership" | "peers"
  > {
  /** Files of `assets.directory` (path "/a/b.html" → bytes), loaded by the host. */
  assetFiles?: AssetFiles;
  /** A celld fleet bucket shared with celld nodes: R2 bindings store objects in it (celld's layout). */
  bucketStore?: import("../bucket/object-store.js").ObjectStore;
  /** Runs each loaded Worker in its own realm (celld isolates); classes still use `loadModules`. */
  isolatedModules?: ModuleLoader;
  /** Compiles code given to a Worker Loader binding (esbuild on Node, webrun-modules in browsers). */
  loadModules?: ModuleLoader;
  /** Blob store of the KV simulator (large values): OPFS in a browser, a directory or S3 on a server. */
  files: FilesApi;
}

export interface ProjectRuntime {
  runtime: CellRuntime;
  /** Configuration entries webrun-cells does not support yet (reported, not silently ignored). */
  unsupported: string[];
}

// Internal bindings carrying the runtime-supplied objects behind KV and D1.
const KV_OBJECTS = "__CELLS_KV_OBJECTS";
const D1_OBJECTS = "__CELLS_D1_OBJECTS";
const QUEUE_OBJECTS = "__CELLS_QUEUE_OBJECTS";
const WORKFLOW_OBJECTS = "__CELLS_WORKFLOW_OBJECTS";

/**
 * Builds a runtime from a wrangler config and the Worker's module namespace — the same
 * inputs celld deploys. Hosts differ only in `host` (storage) and in how they load `main`.
 */
export function createProjectRuntime(
  config: WranglerConfig,
  module: WorkerModule,
  host: ProjectHost,
): ProjectRuntime {
  const unsupported: string[] = [];
  const durableObjects: NonNullable<CellRuntimeOptions["durableObjects"]> = {};
  const sqliteClasses = new Set<string>();
  for (const m of config.migrations ?? []) {
    for (const c of m.new_sqlite_classes ?? []) sqliteClasses.add(c);
    for (const c of m.new_classes ?? []) sqliteClasses.add(c); // KV-backed on Cloudflare; SQLite here (superset)
    for (const r of m.renamed_classes ?? [])
      unsupported.push(`migrations.renamed_classes (${r.from} → ${r.to})`);
  }
  for (const b of config.durable_objects?.bindings ?? []) {
    if (b.script_name) unsupported.push(`durable_objects.bindings[${b.name}].script_name`);
    durableObjects[b.name] = { className: b.class_name };
  }
  const worker: WorkerModule = { ...module };
  let kv: ReturnType<typeof celldKv> | undefined;
  if (config.kv_namespaces?.length) {
    kv = celldKv(host.files);
    worker.__KvNamespace = kv.KvNamespaceCell as never;
    durableObjects[KV_OBJECTS] = { className: "__KvNamespace" };
  }
  if (config.d1_databases?.length) {
    worker.__D1Database = D1DatabaseObject;
    durableObjects[D1_OBJECTS] = { className: "__D1Database" };
  }
  // Queues: every queue is a cell of a runtime-supplied class (as on celld).
  const consumers = new Map((config.queues?.consumers ?? []).map((c) => [c.queue, c]));
  // celld's own queue code (vendor/celld/queues.js): its queue cell, producer and consumer
  // batch, so a queue's cell (and pending messages) is celld's format.
  let queueDispatcher: QueueDispatcher | undefined;
  let queues: ReturnType<typeof celldQueues> | undefined;
  if (config.queues?.producers?.length || consumers.size) {
    queues = celldQueues({
      namespace: () => runtime.env[QUEUE_OBJECTS] as never,
      consumers: [...consumers.values()],
      compatibilityDate: config.compatibility_date,
      runConsumer: (batch) => queueDispatcher!.deliver(batch as never),
    });
    worker.__Queue = queues.QueueCell as never;
    durableObjects[QUEUE_OBJECTS] = { className: "__Queue" };
  }
  // Workflows: every instance is a cell of a runtime-supplied class (as on celld).
  // celld's own workflow code (vendor/celld/workflows.js): its instance cell and binding.
  let workflows: ReturnType<typeof celldWorkflows> | undefined;
  if (config.workflows?.length) {
    workflows = celldWorkflows({
      script: config.name ?? "worker",
      workflows: Object.fromEntries(config.workflows.map((w) => [w.name, w.class_name])),
      exports: () => module as Record<string, unknown>,
      env: () => runtime.env,
      namespace: () => runtime.env[WORKFLOW_OBJECTS],
    });
    worker[workflows.className] = workflows.WorkflowCell as never;
    durableObjects[WORKFLOW_OBJECTS] = { className: workflows.className };
  }
  for (const s of config.services ?? [])
    if (s.service !== config.name)
      unsupported.push(
        `services[${s.binding}] → "${s.service}" (only this script's own entrypoints)`,
      );
  const sqlExtensions: string[] = [];
  let deleteAllPreservesAlarm = false;
  for (const f of config.compatibility_flags ?? []) {
    if (f === "delete_all_preserves_alarm") deleteAllPreservesAlarm = true;
    else if (f === "delete_all_deletes_alarm")
      continue; // the default
    else if (f === "sqlite_vec")
      sqlExtensions.push("sqlite_vec"); // vec0 virtual tables, as on celld
    else if (f === "nodejs_compat" || f === "nodejs_compat_v2")
      continue; // the host's bundler maps node:*
    else unsupported.push(`compatibility_flags: ${f}`);
  }

  const runtime = createCellRuntime({
    worker,
    durableObjects,
    vars: { ...config.vars, MINIFLARE_BLOBS: filesApiBlobService(host.files) },
    openSql: host.openSql,
    sqlExtensions,
    deleteAllPreservesAlarm,
    scriptName: config.name ?? "worker",
    // celld's fleet-wide namespaces for the resources several scripts can share.
    namespaceKeys: {
      __KvNamespace: "cells:v1:kv:__KvNamespace",
      __D1Database: "cells:v1:d1:__D1Database",
      __Queue: "cells:v1:queue:__Queue",
    },
    durability: host.durability,
    backup: host.backup,
    clock: host.clock,
    ownership: host.ownership,
    peers: host.peers,
  });
  const env = runtime.env as Record<string, unknown>;
  // KV: celld's own client against celld's own namespace cell (cell name "<id>/<shard>").
  for (const ns of config.kv_namespaces ?? [])
    env[ns.binding] = new kv!.KvNamespace(() => env[KV_OBJECTS], `${ns.id}/0`);
  for (const p of config.queues?.producers ?? [])
    env[p.binding] = queues!.producer(p.queue, p.delivery_delay ?? 0);
  if (consumers.size) {
    const handler = (module.default as { queue?: (b: unknown, e: unknown, c: unknown) => unknown })
      .queue;
    if (typeof handler !== "function")
      unsupported.push("queues.consumers without a queue() handler");
    queueDispatcher = {
      deliver: async (batch) => {
        const pending: Promise<unknown>[] = [];
        await handler?.call(module.default, batch, env, {
          waitUntil: (p: Promise<unknown>) => pending.push(p),
          passThroughOnException() {},
        });
        await Promise.allSettled(pending);
      },
    };
  }
  for (const l of config.worker_loaders ?? []) {
    if (!host.loadModules)
      unsupported.push(`worker_loaders[${l.binding}] (the host provides no module loader)`);
    else
      env[l.binding] = host.isolatedModules
        ? workerLoader(host.isolatedModules) // facets of loaded code run in the isolate as well
        : workerLoader(host.loadModules);
  }
  // Cron Triggers (validated at load time like `celld deploy` does).
  const crons = config.triggers?.crons ?? [];
  if (crons.length) {
    const scheduled = (
      module.default as { scheduled?: (c: unknown, e: unknown, x: unknown) => unknown }
    ).scheduled;
    if (typeof scheduled !== "function")
      unsupported.push("triggers.crons without a scheduled() handler");
    else {
      const stop = startCronTriggers(
        crons,
        (c, x) => scheduled.call(module.default, c, env, x),
        host.clock ?? systemClock,
        cronState(host.openSql("__webrun-cells/cron")),
      );
      const close = runtime.close.bind(runtime);
      runtime.close = async () => {
        stop();
        await close();
      };
    }
  }
  // Static assets: routed before the Worker; `assets.binding` exposes env.ASSETS.
  if (config.assets) {
    const hasWorker = typeof (module.default as { fetch?: unknown })?.fetch === "function";
    if (host.assetFiles?.has("/.assetsignore"))
      throw new Error(
        `${config.assets.directory ?? "assets"}/.assetsignore is not supported by celld; remove it`,
      );
    const assets = createAssets(host.assetFiles ?? new Map(), config.assets, hasWorker);
    if (config.assets.binding) env[config.assets.binding] = assets.binding;
    const workerFetch = runtime.fetch.bind(runtime);
    runtime.fetch = async (req) =>
      assets.route(req) ??
      (hasWorker ? workerFetch(req) : new Response("Not found", { status: 404 }));
  }
  for (const w of config.workflows ?? []) env[w.binding] = workflows!.binding(w.name);
  // Service bindings to this script's own entrypoints (a celld fleet runs one application):
  // default export or a named WorkerEntrypoint, with fetch() and JS RPC.
  for (const s of config.services ?? []) {
    if (s.service !== config.name) continue;
    const target = s.entrypoint ? module[s.entrypoint] : module.default;
    if (!target)
      unsupported.push(`services[${s.binding}].entrypoint "${s.entrypoint}" is not exported`);
    else env[s.binding] = entrypointStub(target, env, s.props);
  }
  // R2 objects live directly in the host's store, as celld keeps them in the fleet bucket.
  // With a celld fleet bucket, R2 objects live in it as celld keeps them; else in the FilesApi.
  for (const r2 of config.r2_buckets ?? [])
    env[r2.binding] = host.bucketStore
      ? r2BucketOn(celldR2Backend(host.bucketStore, r2.bucket_name), r2.binding)
      : r2Bucket(host.files, `/r2/${r2.bucket_name}`, r2.binding);
  for (const d1 of config.d1_databases ?? [])
    env[d1.binding] = celldExec(
      makeD1Binding({
        fetcher: simulatorFetcher(
          env[D1_OBJECTS] as DurableObjectNamespace,
          d1.database_id,
        ) as never,
      }) as D1Like,
    );
  for (const name of [...sqliteClasses])
    if (!Object.values(durableObjects).some((d) => d.className === name)) {
      // A migrated class without a binding is fine (reachable through other code paths only).
    }
  return { runtime, unsupported };
}

interface D1Like {
  exec(sql: string): Promise<{ count: number; duration: number }>;
  prepare(sql: string): { run(): Promise<unknown> };
}

/**
 * `D1Database#exec` as celld implements it: statements are split by SQL syntax.
 * workerd's d1-api.ts splits on NEWLINES (Cloudflare's documented behaviour), so a
 * multi-line `CREATE TABLE` fails there but works on celld — and celld is the
 * reference here (verified on celld 0.6.2 by the d1 example in conformance/).
 */
function celldExec<T extends D1Like>(db: T): T {
  const exec = async (sql: string) => {
    const t0 = Date.now();
    const statements = splitSqlStatements(sql).filter((s) => s.trim());
    for (const statement of statements) {
      if (/^\s*BEGIN\b/i.test(statement))
        throw new Error(
          "D1_EXEC_ERROR: the SQL ends in an incomplete statement, which did not run: terminate the last statement with a semicolon",
        );
      guard(statement);
      await db.prepare(statement).run();
    }
    return { count: statements.length, duration: Date.now() - t0 };
  };
  return celldD1(db, exec) as T;
}

/**
 * celld's D1 rules on top of workerd's client (celld docs/services/d1.md, checked by the
 * d1-details project): ATTACH/DETACH and TEMP objects are "not authorized", VACUUM is
 * "authorization denied"; there is one primary and no replica, so sessions return the
 * bookmark "celld:primary" and every result reports served_by_primary/served_by_region
 * "local"; a read-only statement reports last_row_id and changes as 0.
 */
function guard(sql: string): void {
  if (/^\s*(ATTACH|DETACH)\b/i.test(sql) || /^\s*CREATE\s+(TEMP|TEMPORARY)\b/i.test(sql))
    throw new Error("D1_ERROR: not authorized");
  if (/^\s*VACUUM\b/i.test(sql)) throw new Error("D1_ERROR: authorization denied");
}

function celldMeta(r: any): any {
  if (!r?.meta) return r;
  r.meta.served_by_primary = true;
  r.meta.served_by_region = "local";
  if (r.meta.changed_db === false) {
    r.meta.last_row_id = 0;
    r.meta.changes = 0;
  }
  return r;
}

function celldStatement(stmt: any): any {
  return new Proxy(stmt, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "bind") return (...a: unknown[]) => celldStatement(v.apply(t, a));
      if (p === "run" || p === "all")
        return async (...a: unknown[]) => celldMeta(await v.apply(t, a));
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

function celldD1(db: any, exec?: (sql: string) => Promise<unknown>): any {
  return new Proxy(db, {
    get(t, p, r) {
      if (p === "exec" && exec) return exec;
      const v = Reflect.get(t, p, r);
      if (p === "prepare")
        return (sql: string) => {
          guard(sql);
          return celldStatement(v.call(t, sql));
        };
      if (p === "batch")
        return async (stmts: unknown[], ...a: unknown[]) =>
          ((await v.call(t, stmts, ...a)) as unknown[]).map(celldMeta);
      if (p === "withSession")
        return () => {
          const session = celldD1(t);
          return new Proxy(session, {
            get: (s, q, rr) =>
              q === "getBookmark" ? () => "celld:primary" : Reflect.get(s, q, rr),
          });
        };
      if (p === "getBookmark") return () => "celld:primary";
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** Last fired occurrence per cron expression, in a small SQLite database of the host. */
function cronState(db: ReturnType<ProjectHost["openSql"]>) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS cron_state (expression TEXT PRIMARY KEY, scheduled_time INTEGER)",
    [],
  );
  return {
    get: (e: string) => {
      const row = db.exec("SELECT scheduled_time FROM cron_state WHERE expression = ?", [e])
        .rows[0];
      return row ? Number(row[0]) : undefined;
    },
    set: (e: string, t: number) =>
      void db.exec("INSERT OR REPLACE INTO cron_state (expression, scheduled_time) VALUES (?, ?)", [
        e,
        t,
      ]),
  };
}
