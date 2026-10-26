import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { sahpoolOpener } from "../adapters/wasm-sqlite.js";
import type { AssetFiles } from "../bindings/assets.js";
import { celldBucket } from "../bucket/celld-cells.js";
import { filesApiObjectStore, type ObjectStore } from "../bucket/object-store.js";
import { s3ObjectStore } from "../bucket/s3-object-store.js";
import type { WorkerModule } from "../core/runtime.js";
import { browserIsolatedLoader } from "../isolate/browser.js";
import { installNodeGlobals } from "../node-compat/install.js";
import { browserModuleLoader } from "./browser-modules.js";
import * as workersModule from "./cloudflare-workers.js";
import { siteModuleLoader, workersHostRegistry } from "./site.js";
import { setRealmWorkerScope, workerScope } from "./worker-scope.js";
import * as workersGlobals from "./workers-globals-module.js";
import { createProjectRuntime, type WranglerConfig } from "./wrangler.js";

/**
 * Where a browser-hosted project keeps its cells when they must outlive the page or move to
 * other nodes: a celld fleet bucket. Cells, facets and alarms are then exactly celld's
 * (ownership in `own.json`, LTX logs, wake index) and R2 objects live in it too, so the same
 * cells can be served by this browser, by other browsers and by celld nodes, in turn.
 *
 * - `s3`: an S3-compatible bucket, reached directly (the bucket must allow CORS for the page's
 *   origin: methods GET/PUT/DELETE/HEAD, request headers `authorization`, `content-type`,
 *   `x-amz-*`, `if-match`, `if-none-match`; exposed headers `etag`, `last-modified`,
 *   `x-amz-meta-celld-r2`) or through a same-origin proxy (`endpoint` = the proxy,
 *   `signAs` = the real endpoint: SigV4 signs the real host and path).
 * - `opfs`: a bucket in this origin's OPFS — persistence without a server. Conditional writes
 *   are atomic only within one writer, so one tab or worker at a time should own its cells.
 * - `store`: any ObjectStore.
 */
export type BrowserBucket =
  | {
      s3: {
        endpoint: string;
        signAs?: string;
        bucket: string;
        prefix?: string;
        region?: string;
        accessKeyId: string;
        secretAccessKey: string;
      };
      node: string;
      leaseTtlMs?: number;
    }
  | { opfs: string; node: string; leaseTtlMs?: number }
  | { store: ObjectStore; node: string; leaseTtlMs?: number };

export interface BrowserProjectOptions {
  config: WranglerConfig;
  /**
   * The project's Worker code, imported in this realm once its Workers globals (and with
   * nodejs_compat `Buffer` and `process`) are installed:
   * - `bundle`: one ES module built for browsers, whose `cloudflare:workers` is
   *   `WORKERS_MODULE_SHIM` and whose Workers globals read `globalThis.__cellsGlobals`
   *   (`null`: the project has no `main`). Worker Loader code becomes Blob-URL modules.
   * - `site`: the base URL of the project's site (`createProjectSite`, hosted by
   *   webrun-site-host). `main` and Worker Loader code are imported from it.
   */
  code: { bundle: string | null } | { site: string };
  /**
   * A Dedicated Worker script that serves one loaded Worker (`serveIsolate`): Worker Loader
   * code then runs isolated, one Dedicated Worker per loaded Worker, as celld's isolates.
   * The package ships one: `@statewalker/cellb/isolate-worker`.
   */
  isolateScript?: URL;
  /** An initialized SQLite WASM module (`@sqlite.org/sqlite-wasm`). */
  sqlite3: unknown;
  /** OPFS sahpool name for this host's SQLite files (one pool per worker). */
  pool: string;
  /** OPFS directory for the project's FilesApi (Workers' fs-like bindings, R2 without bucket). */
  filesDir: string;
  assetFiles?: AssetFiles;
  bucket?: BrowserBucket;
}

async function bucketStore(b: BrowserBucket): Promise<ObjectStore> {
  if ("store" in b) return b.store;
  if ("s3" in b) return s3ObjectStore({ region: "us-east-1", ...b.s3 });
  const root = await navigator.storage.getDirectory();
  return filesApiObjectStore(
    new BrowserFilesApi({ rootHandle: await root.getDirectoryHandle(b.opfs, { create: true }) }),
    "",
  );
}

/** Installs the Workers globals the code reads, then imports its `main`. */
async function importWorkerCode(
  config: WranglerConfig,
  code: BrowserProjectOptions["code"],
): Promise<WorkerModule> {
  const flags = config.compatibility_flags ?? [];
  const nodeCompat = flags.some((f) => f.startsWith("nodejs_compat"));
  if (nodeCompat) installNodeGlobals();
  const globals = {
    ...workersGlobals,
    Response: workersGlobals.CellsResponse,
    WebSocket: workersGlobals.WorkersWebSocket,
    WebSocketPair: flags.includes("websocket_standard_binary_type")
      ? workersGlobals.StandardWebSocketPair
      : workersGlobals.WebSocketPair,
  };
  if ("site" in code) {
    workersHostRegistry({
      workersModule,
      ...globals,
      // Loaded on demand, after installNodeGlobals(): the npm `util` polyfill reads `process`
      // when it is imported.
      node: nodeCompat
        ? (await import("../node-compat/browser-registry.js")).nodeRegistryEntries
        : undefined,
    });
    return config.main
      ? await import(/* @vite-ignore */ `${code.site}modules/~/${config.main}`)
      : { default: {} };
  }
  const g = globalThis as Record<string, unknown>;
  g.__cellsWorkersModule = workersModule;
  g.__cellsGlobals = globals;
  return code.bundle
    ? await import(
        /* @vite-ignore */ URL.createObjectURL(new Blob([code.bundle], { type: "text/javascript" }))
      )
    : { default: {} };
}

/**
 * A project's runtime in this worker: installs the Workers globals, imports the code and
 * builds its Worker Loader; `close()` also releases the node's bucket lease.
 */
export async function browserProjectRuntime(opts: BrowserProjectOptions) {
  // This realm runs the project's Worker: its `cloudflare:workers` env/exports, readable
  // while the module is evaluated (the vars, until the runtime exists).
  const scope = workerScope(opts.config.vars);
  setRealmWorkerScope(scope);
  const module = await importWorkerCode(opts.config, opts.code);
  const site = "site" in opts.code ? opts.code.site : undefined;
  const openSql = await sahpoolOpener(opts.sqlite3 as never, {
    name: opts.pool,
    initialCapacity: 32,
  });
  const root = await navigator.storage.getDirectory();
  const files = new BrowserFilesApi({
    rootHandle: await root.getDirectoryHandle(opts.filesDir, { create: true }),
  });
  const store = opts.bucket ? await bucketStore(opts.bucket) : undefined;
  const shared =
    opts.bucket && store
      ? celldBucket(store, { node: opts.bucket.node, leaseTtlMs: opts.bucket.leaseTtlMs })
      : undefined;
  const { runtime, unsupported } = createProjectRuntime(opts.config, module, {
    openSql,
    files,
    assetFiles: opts.assetFiles,
    loadModules: site ? siteModuleLoader(site) : browserModuleLoader(),
    isolatedModules: opts.isolateScript
      ? browserIsolatedLoader({
          isolateScript: opts.isolateScript,
          siteBaseUrl: site,
          storagePrefix: `${opts.pool}-iso`,
        })
      : undefined,
    storage: shared, // R2 objects in the fleet bucket too, as celld keeps them
  });
  scope.bind(runtime);
  return {
    runtime,
    unsupported,
    bucket: shared,
    close: () => runtime.close(),
  };
}
