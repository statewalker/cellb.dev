import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { installLtxVfs } from "../adapters/ltx-vfs.js";
import { sahpoolOpener, WasmSqliteDriver, wasmMemoryOpener } from "../adapters/wasm-sqlite.js";
import type { AssetFiles } from "../bindings/assets.js";
import type { WorkersAiOptions } from "../bindings/workers-ai.js";
import { celldBucket } from "../bucket/celld-cells.js";
import { idbObjectStore } from "../bucket/idb-object-store.js";
import { filesApiObjectStore, type ObjectStore } from "../bucket/object-store.js";
import { s3ObjectStore } from "../bucket/s3-object-store.js";
import type { CellRuntimeOptions, WorkerModule } from "../core/runtime.js";
import { browserIsolatedLoader } from "../isolate/browser.js";
import { installAsyncContext } from "../node-compat/async_hooks.js";
import { installNodeGlobals } from "../node-compat/install.js";
import { browserModuleLoader } from "./browser-modules.js";
import * as workersModule from "./cloudflare-workers.js";
import { siteModuleLoader, workersHostRegistry } from "./site.js";
import { type WorkerScope, workerScope } from "./worker-scope.js";
import * as workersGlobals from "./workers-globals-module.js";
import { createProjectRuntime, loadTimeEnv, type WranglerConfig } from "./wrangler.js";

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
  /**
   * `idb`: a bucket in this origin's IndexedDB (atomic conditional writes across tabs and
   * workers). Cells then run SQLite in memory and persist through the bucket's page-level logs:
   * no OPFS pool, so any number of workers can serve cells at once.
   */
  | { idb: string; node: string; leaseTtlMs?: number }
  /**
   * `ltx`: cells as celld keeps them, LTX files (a snapshot and one file per commit) in an OPFS
   * directory, read page by page (a SQLite VFS over a store worker): no OPFS pool, and a
   * cell's memory is its page cache, not its database. Files past `compactAfter` (default
   * 64) are folded into one snapshot, streamed.
   */
  | { ltx: string; node: string; leaseTtlMs?: number; compactAfter?: number }
  | { store: ObjectStore; node: string; leaseTtlMs?: number };

export interface BrowserProjectOptions {
  config: WranglerConfig;
  /**
   * The project's Worker code, imported in this realm once its Workers globals (and with
   * nodejs_compat `Buffer` and `process`) are installed:
   * - `bundle`: one ES module built for browsers (`bundleWorkerForBrowser`), whose
   *   `cloudflare:workers` is `PROJECT_WORKERS_MODULE_SHIM` and whose Workers globals read
   *   `globalThis.__cellsGlobals`
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
  /**
   * Cells this runtime does not host: where to send their events (a `Send` over a MessagePort
   * to the runtime that hosts them, `linkOverPort`), or undefined to host the cell here. With
   * one runtime per worker and `shardOf` as the placement, cells run in parallel threads.
   */
  route?: CellRuntimeOptions["route"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding (Workers AI). */
  ai?: WorkersAiOptions;
}

async function bucketStore(b: BrowserBucket): Promise<ObjectStore> {
  if ("store" in b) return b.store;
  if ("s3" in b) return s3ObjectStore({ region: "us-east-1", ...b.s3 });
  if ("idb" in b) return idbObjectStore(b.idb);
  if ("ltx" in b) throw new Error("an ltx directory is cell storage, not a bucket");
  const root = await navigator.storage.getDirectory();
  return filesApiObjectStore(
    new BrowserFilesApi({ rootHandle: await root.getDirectoryHandle(b.opfs, { create: true }) }),
    "",
  );
}

/**
 * Cells on the LTX VFS: a store worker owns the OPFS directory; each cell is a SQLite database
 * whose main file is its LTX files, read page by page (src/adapters/ltx-vfs.ts).
 */
async function ltxOpener(sqlite3: unknown, dir: string, compactAfter?: number) {
  const store = new Worker(
    new URL("../ltx/ltx-store-worker.ts", import.meta.url) /* cellb ships its TypeScript sources */,
    { type: "module" },
  );
  const sab = new SharedArrayBuffer(8 + 16 * 65536); // room for a read-ahead run of 64 KiB pages
  // Wait until the store worker runs before any synchronous call: a nested worker is started
  // (its script fetched) through this worker's event loop, which Atomics.wait would block.
  const ready = new Promise<void>((resolve, reject) => {
    store.addEventListener("message", (e) => e.data?.op === "ready" && resolve(), { once: false });
    store.addEventListener("error", (e) => reject(new Error(`ltx store worker: ${e.message}`)));
  });
  store.postMessage({ op: "init", sab, dir, compactAfter });
  await ready;
  const { name } = installLtxVfs(sqlite3, { sab, post: (m) => store.postMessage(m) });
  const s3 = sqlite3 as { oo1: { DB: new (o: Record<string, unknown>) => any } };
  const open = (cellKey: string) => {
    const db = new s3.oo1.DB({ filename: cellKey, vfs: name, flags: "c" });
    db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=FULL;");
    return new WasmSqliteDriver(db);
  };
  return Object.assign(open, {
    release() {
      store.terminate();
    },
    reserve: async (n: number) => n,
  });
}

/** Installs the Workers globals the code reads, then imports its `main`. */
async function importWorkerCode(
  config: WranglerConfig,
  code: BrowserProjectOptions["code"],
  scope: WorkerScope,
): Promise<WorkerModule> {
  const flags = config.compatibility_flags ?? [];
  const nodeCompat = flags.some((f) => f.startsWith("nodejs_compat"));
  if (nodeCompat) {
    installNodeGlobals();
    // node:* for bundles built with cellbHostModule (another bundler than bundleWorkerForBrowser);
    // loaded after installNodeGlobals(), as the npm `util` polyfill reads `process`.
    (globalThis as Record<string, unknown>).__cellsNodeModules = (
      await import("../node-compat/browser-registry.js")
    ).nodeRegistryEntries;
    if (populatesProcessEnv(config)) {
      const env = processEnvOf(config);
      // The bundle's own `process` reads it when evaluated; a site's modules use this realm's.
      (globalThis as Record<string, unknown>).__cellsProcessEnv = env;
      Object.assign((globalThis as { process: { env: Record<string, string> } }).process.env, env);
    }
    // node:async_hooks: continuations carry their AsyncLocalStorage stores (with AsyncContext
    // the engine does, and this installs nothing). The code's awaits are lowered so that they go
    // through them: by bundleWorkerForBrowser for a bundle, by createProjectSite (nodeCompat) for
    // a site's modules.
    installAsyncContext();
  }
  const globals = {
    ...workersGlobals,
    Request: workersGlobals.CellsRequest,
    Response: workersGlobals.CellsResponse,
    WebSocketPair: flags.includes("websocket_standard_binary_type")
      ? workersGlobals.StandardWebSocketPair
      : workersGlobals.WebSocketPair,
  };
  if ("site" in code) {
    workersHostRegistry({
      workersModule,
      projectWorkersModule: {
        ...workersModule,
        env: scope.env,
        exports: scope.exports,
        waitUntil: scope.waitUntil,
      },
      loadedPrefix: `${code.site}loaded/`,
      emailModule: await import("./cloudflare-email.js"),
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
  g.__cellsProjectScope = scope; // `env` and `exports` of the bundle's cloudflare:workers
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
  const scope = workerScope(loadTimeEnv(opts.config, opts.ai));
  const module = await importWorkerCode(opts.config, opts.code, scope);
  const site = "site" in opts.code ? opts.code.site : undefined;
  // With an IndexedDB bucket, cells live in memory and in the bucket's logs (no OPFS pool).
  const openSql =
    opts.bucket && "ltx" in opts.bucket
      ? await ltxOpener(opts.sqlite3, opts.bucket.ltx, opts.bucket.compactAfter)
      : opts.bucket && "idb" in opts.bucket
        ? Object.assign(wasmMemoryOpener(opts.sqlite3 as never), {
            release() {},
            reserve: async (n: number) => n,
          })
        : await sahpoolOpener(opts.sqlite3 as never, {
            name: opts.pool,
            initialCapacity: 64, // grows on demand (sahpoolOpener)
          });
  const root = await navigator.storage.getDirectory();
  const files = new BrowserFilesApi({
    rootHandle: await root.getDirectoryHandle(opts.filesDir, { create: true }),
  });
  // An `ltx` directory is the cells' own storage (the VFS), not a fleet bucket.
  const store = opts.bucket && !("ltx" in opts.bucket) ? await bucketStore(opts.bucket) : undefined;
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
          storage: () => shared, // facets of loaded code are logged like the root's own
        })
      : undefined,
    storage: shared, // R2 objects in the fleet bucket too, as celld keeps them
    route: opts.route,
    ai: opts.ai,
  });
  scope.bind(runtime);
  return {
    runtime,
    unsupported,
    bucket: shared,
    close: async () => {
      await runtime.close();
      openSql.release(); // the pool's files, for the next worker that opens it
    },
  };
}

/**
 * workerd fills `process.env` with the project's text `vars` under nodejs_compat from
 * compatibility date 2025-04-01 (`nodejs_compat_populate_process_env`), unless
 * `nodejs_compat_do_not_populate_process_env` is set. Frameworks read their settings there
 * (EmDash's `EMDASH_SITE_URL`, for one).
 */
export function populatesProcessEnv(config: WranglerConfig): boolean {
  const flags = config.compatibility_flags ?? [];
  if (!flags.some((f) => f.startsWith("nodejs_compat"))) return false;
  if (flags.includes("nodejs_compat_do_not_populate_process_env")) return false;
  if (flags.includes("nodejs_compat_populate_process_env")) return true;
  return (config.compatibility_date ?? "") >= "2025-04-01";
}

/** The text `vars` of a project, as `process.env` holds them. */
export function processEnvOf(config: WranglerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.vars ?? {})) if (typeof v === "string") env[k] = v;
  return env;
}
