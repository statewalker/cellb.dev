import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { sahpoolOpener } from "../adapters/wasm-sqlite.js";
import type { AssetFiles } from "../bindings/assets.js";
import type { ModuleLoader } from "../bindings/worker-loader.js";
import { celldBucket } from "../bucket/celld-cells.js";
import { filesApiObjectStore, type ObjectStore } from "../bucket/object-store.js";
import { s3ObjectStore } from "../bucket/s3-object-store.js";
import type { WorkerModule } from "../core/runtime.js";
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
  module: Record<string, unknown>;
  /** An initialized SQLite WASM module (`@sqlite.org/sqlite-wasm`). */
  sqlite3: unknown;
  /** OPFS sahpool name for this host's SQLite files (one pool per worker). */
  pool: string;
  /** OPFS directory for the project's FilesApi (Workers' fs-like bindings, R2 without bucket). */
  filesDir: string;
  assetFiles?: AssetFiles;
  loadModules?: ModuleLoader;
  isolatedModules?: ModuleLoader;
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

/** A project's runtime in this worker; `close()` also releases the node's bucket lease. */
export async function browserProjectRuntime(opts: BrowserProjectOptions) {
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
  const { runtime, unsupported } = createProjectRuntime(
    opts.config,
    opts.module as WorkerModule,
    {
      openSql,
      files,
      assetFiles: opts.assetFiles,
      loadModules: opts.loadModules,
      isolatedModules: opts.isolatedModules,
      ...(shared
        ? {
            ownership: shared.ownership,
            durability: shared.durability,
            backup: shared.durability,
            bucketStore: shared.store, // R2 objects in the fleet bucket, as celld keeps them
          }
        : {}),
    } as never,
  );
  return {
    runtime,
    unsupported,
    bucket: shared,
    async close() {
      await runtime.close();
      await shared?.close();
    },
  };
}
