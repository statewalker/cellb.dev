import type { FilesApi } from "@statewalker/webrun-files";
import { type AssetFiles, type AssetsConfig, createAssets } from "../bindings/assets.js";
import { startCronTriggers } from "../bindings/cron.js";
import {
  makeQueueCell,
  type QueueConsumerConfig,
  type QueueDispatcher,
  queueProducer,
} from "../bindings/queues.js";
import { r2Bucket } from "../bindings/r2.js";
import { type ModuleLoader, workerLoader } from "../bindings/worker-loader.js";
import { makeWorkflowCell, type WorkflowConfig, workflowBinding } from "../bindings/workflows.js";
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
import { kvNamespaceBinding } from "../miniflare-compat/kv-binding.js";
import { simulatorFetcher } from "../miniflare-compat/simulator-fetcher.js";
import {
  D1DatabaseObject,
  KVNamespaceObject,
  makeD1Binding,
} from "../miniflare-compat/vendored.js";

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
  services?: unknown[];
  worker_loaders?: { binding: string }[];
}

export interface ProjectHost
  extends Pick<CellRuntimeOptions, "openSql" | "durability" | "backup" | "clock"> {
  /** Files of `assets.directory` (path "/a/b.html" → bytes), loaded by the host. */
  assetFiles?: AssetFiles;
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
  if (config.kv_namespaces?.length) {
    worker.__CellsKVNamespace = KVNamespaceObject;
    durableObjects[KV_OBJECTS] = { className: "__CellsKVNamespace" };
  }
  if (config.d1_databases?.length) {
    worker.__CellsD1Database = D1DatabaseObject;
    durableObjects[D1_OBJECTS] = { className: "__CellsD1Database" };
  }
  // Queues: every queue is a cell of a runtime-supplied class (as on celld).
  const consumers = new Map((config.queues?.consumers ?? []).map((c) => [c.queue, c]));
  let queueDispatcher: QueueDispatcher | undefined;
  if (config.queues?.producers?.length || consumers.size) {
    worker.__CellsQueue = makeQueueCell(
      consumers,
      () => queueDispatcher,
      () => runtime.env[QUEUE_OBJECTS] as DurableObjectNamespace,
      host.clock ? () => host.clock!.now() : undefined,
    );
    durableObjects[QUEUE_OBJECTS] = { className: "__CellsQueue" };
  }
  // Workflows: every instance is a cell of a runtime-supplied class (as on celld).
  if (config.workflows?.length) {
    worker.__CellsWorkflow = makeWorkflowCell(
      (name) => module[name] as never,
      () => runtime.env,
      host.clock ? () => host.clock!.now() : undefined,
    );
    durableObjects[WORKFLOW_OBJECTS] = { className: "__CellsWorkflow" };
  }
  for (const key of ["services"] as const)
    if (config[key] && (!Array.isArray(config[key]) || (config[key] as unknown[]).length))
      unsupported.push(key);
  const sqlExtensions: string[] = [];
  for (const f of config.compatibility_flags ?? []) {
    if (f === "sqlite_vec")
      sqlExtensions.push("sqlite_vec"); // vec0 virtual tables, as on celld
    else unsupported.push(`compatibility_flags: ${f}`);
  }

  const runtime = createCellRuntime({
    worker,
    durableObjects,
    vars: { ...config.vars, MINIFLARE_BLOBS: filesApiBlobService(host.files) },
    openSql: host.openSql,
    sqlExtensions,
    durability: host.durability,
    backup: host.backup,
    clock: host.clock,
  });
  const env = runtime.env as Record<string, unknown>;
  for (const kv of config.kv_namespaces ?? [])
    env[kv.binding] = kvNamespaceBinding(env[KV_OBJECTS] as DurableObjectNamespace, kv.id);
  for (const p of config.queues?.producers ?? [])
    env[p.binding] = queueProducer(
      env[QUEUE_OBJECTS] as DurableObjectNamespace,
      p.queue,
      p.delivery_delay ?? 0,
    );
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
    else env[l.binding] = workerLoader(host.loadModules);
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
    const assets = createAssets(host.assetFiles ?? new Map(), config.assets, hasWorker);
    if (config.assets.binding) env[config.assets.binding] = assets.binding;
    const workerFetch = runtime.fetch.bind(runtime);
    runtime.fetch = async (req) =>
      assets.route(req) ??
      (hasWorker ? workerFetch(req) : new Response("Not found", { status: 404 }));
  }
  for (const w of config.workflows ?? [])
    env[w.binding] = workflowBinding(env[WORKFLOW_OBJECTS] as DurableObjectNamespace, w);
  // R2 objects live directly in the host's store, as celld keeps them in the fleet bucket.
  for (const r2 of config.r2_buckets ?? [])
    env[r2.binding] = r2Bucket(host.files, `/r2/${r2.bucket_name}`);
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
    for (const statement of statements) await db.prepare(statement).run();
    return { count: statements.length, duration: Date.now() - t0 };
  };
  return new Proxy(db, { get: (t, p, r) => (p === "exec" ? exec : Reflect.get(t, p, r)) });
}
