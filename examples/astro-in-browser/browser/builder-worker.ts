/// <reference lib="webworker" />
// Builds an Astro app in this worker: esbuild-wasm, Astro's compiler (wasm, from npm), and
// webrun-bundler with packages from the npm registry. Receives { sources: { path: bytes },
// integrations?: boolean } and answers { code, clientAssets } or { error }, posting { log } on
// the way. With `integrations`, astro.config.mjs and its integrations run first (EmDash), and
// the Worker is built for cellb's runtime (its node:* polyfills, cloudflare:workers, globals).
import "./process-shim.ts";
import { CELLS_GLOBALS_MODULE, cellbHostModule } from "@statewalker/cellb/host-modules";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import * as esbuild from "esbuild-wasm/esm/browser.js";
import { buildAstroApp } from "../src/builder/build.ts";
import { httpFiles } from "../src/builder/http-files.ts";
import { preloadVfs, runAstroConfig } from "../src/builder/integrations.ts";
import { cachedSource, prefetch } from "../src/builder/package-cache.ts";
import { loadAstroCompiler } from "./compiler.ts";

const log = (line: string) => postMessage({ log: line });
/**
 * The modules each bundle stage has loaded so far, for the page's progress bar: at most one
 * message every 400 ms (EmDash's server bundle loads ~3000), and the last count of a stage.
 */
function progressReporter() {
  let last = 0;
  let scheduled = false;
  let latest: { stage: string; modules: number } | undefined;
  const send = () => {
    scheduled = false;
    last = performance.now();
    if (latest) postMessage({ progress: latest });
  };
  return (stage: string, modules: number) => {
    if (latest && latest.stage !== stage) send(); // the previous stage's final count
    latest = { stage, modules };
    if (performance.now() - last >= 400) send();
    else if (!scheduled) {
      scheduled = true;
      setTimeout(send, 400);
    }
  };
}
const DOWNLOADERS = 1; // each holds one unpacked package while it packs it

/** `n` download workers; a request goes to the least busy one. */
function downloadPool(n: number, store: string) {
  const workers = Array.from({ length: n }, () => ({
    w: new Worker(new URL("./download-worker.ts", import.meta.url), { type: "module" }),
    busy: 0,
  }));
  const waiting = new Map<
    number,
    (r: { name?: string; version?: string; error?: string }) => void
  >();
  for (const x of workers) x.w.onmessage = (e) => waiting.get(e.data.id)?.(e.data);
  let next = 0;
  let done = 0; // downloads finished, logged every 10 (the page's progress)
  return {
    /** Packages fetched from the registry (not found in the store). */
    downloads: 0,
    download(ref: { pkg: string; version?: string }) {
      this.downloads++;
      const x = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      const id = next++;
      x.busy++;
      return new Promise<{ name: string; version: string }>((resolve, reject) => {
        waiting.set(id, (r) => {
          waiting.delete(id);
          x.busy--;
          if (!r.error && ++done % 10 === 0) log(`downloading packages: ${done}`);
          if (r.error) reject(new Error(r.error));
          else resolve({ name: r.name as string, version: r.version as string });
        });
        x.w.postMessage({ id, ...ref, store });
        // A download that does not finish in 2 minutes fails, naming the package.
        setTimeout(
          () =>
            waiting.get(id)?.({
              error: `download of ${ref.pkg}@${ref.version ?? "latest"}: no answer in 120 s`,
            }),
          120_000,
        );
      });
    },
    close: () => {
      for (const x of workers) x.w.terminate();
    },
  };
}
/** wrangler.jsonc's `main`, relative to the app (comments and trailing commas allowed). */
function wranglerMain(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  // Comments out, strings kept (a URL's "//" is inside one).
  const text = new TextDecoder()
    .decode(bytes)
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const main = (JSON.parse(text) as { main?: string }).main;
    return main?.replace(/^\.\//, "");
  } catch {
    return undefined;
  }
}

async function readText(files: { read(p: string): AsyncIterable<Uint8Array> }, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  return chunks.length
    ? new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])))
    : undefined;
}

/**
 * A lease on the package store while this build reads and writes it, renewed every 15 s (the
 * store lets it lapse after 60 s): the host pages' clean-up waits for it. `release()` gives it
 * back.
 */
async function storeLease(store: string) {
  const url = `${store}/admin/lease?id=${crypto.randomUUID()}`;
  const take = () => fetch(url, { method: "POST" }).catch(() => undefined);
  const r = await take();
  if (!r?.ok)
    throw new Error(`package store: could not take a lease (${r?.status ?? "no answer"})`);
  const timer = setInterval(take, 15_000);
  return async () => {
    clearInterval(timer);
    await fetch(url, { method: "DELETE" }).catch(() => undefined);
  };
}

self.onmessage = async (
  e: MessageEvent<{ sources: Record<string, Uint8Array>; integrations?: boolean; store?: string }>,
) => {
  // What a failed build must stop too: the download workers, the store's lease.
  let cleanup = async () => {};
  try {
    const t0 = performance.now();
    // esbuild's wasm in a worker of its own: its memory grows during a bundle and is released
    // only with that worker, so the builder restarts it between the large bundles (`release`).
    // Plugins (the integrations' Vite plugins among them) still run in this worker.
    await esbuild.initialize({ wasmURL, worker: true });
    log(`esbuild-wasm ${esbuild.version} ready`);
    const transform = await loadAstroCompiler();
    log("Astro's compiler (compiler-rs wasm, from npm) ready");
    const files = new MemFilesApi();
    for (const [path, bytes] of Object.entries(e.data.sources)) await files.write(path, [bytes]);
    // Packages: from the npm registry, in this worker's memory (default); with `store`, through
    // the package store (a Durable Object on cellb, which alone owns the storage), with misses
    // downloaded by DOWNLOADERS workers.
    let packages = npmPackages();
    let afterBuild = async () => {};
    if (e.data.store) {
      const app = e.data.integrations ? "emdash" : "app";
      const release = await storeLease(e.data.store);
      const cache = httpFiles(e.data.store);
      const pool = downloadPool(DOWNLOADERS, e.data.store);
      cleanup = async () => {
        pool.close();
        await release();
      };
      const source = cachedSource(cache, npmRegistrySource() as never, undefined, (ref) =>
        pool.download(ref),
      );
      const lockPath = `/locks/${app}.json`;
      const lockText = await readText(cache, lockPath);
      const lock = lockText ? (JSON.parse(lockText) as string[]) : undefined;
      const manifest = JSON.parse(
        new TextDecoder().decode(
          e.data.sources["/app/package.json"] ?? new TextEncoder().encode("{}"),
        ),
      );
      const tp = performance.now();
      if (lock) {
        const n = (await prefetch(source, manifest, { lock })).length;
        log(
          `package cache: ${n} packages from the last build's lock, ready in ${Math.round(performance.now() - tp)} ms`,
        );
      } else
        log(
          "package cache: empty; packages come from the registry and are cached as they are read",
        );
      packages = npmPackages({ source: source as never });
      afterBuild = async () => {
        await cache.write(lockPath, [
          new TextEncoder().encode(JSON.stringify([...source.used].sort())),
        ]);
        await source.flush();
        log(`package store: ${pool.downloads} packages downloaded from the registry`);
        await cleanup();
      };
    }
    let extra = {};
    if (e.data.integrations) {
      const session = {
        driver: "unstorage/drivers/cloudflare-kv-binding",
        options: { binding: "SESSION" },
      };
      log("preloading the packages integrations read at build time…");
      const { vfs, mounts } = await preloadVfs(files, "/app", packages, [
        ["emdash"],
        ["@emdash-cms/admin", "emdash"],
        ["astro"],
      ]);
      log(`build-time file system: ${vfs.size} files`);
      const integration = await runAstroConfig({
        esbuild,
        files,
        root: "/app",
        packages,
        vfs,
        log,
        session,
        evaluate: async (code) => {
          const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          try {
            return await import(/* @vite-ignore */ url);
          } finally {
            URL.revokeObjectURL(url);
          }
        },
      });
      log(
        `integrations: ${integration.routes.length} routes, ${integration.middleware.length} middleware, plugins ${integration.plugins.map((p) => p.name).join(", ")}`,
      );
      extra = {
        integration,
        nodeMounts: mounts,
        hostModules: cellbHostModule,
        inject: [CELLS_GLOBALS_MODULE],
        session,
        // The project's own Worker entry (EmDash's: scheduled() for its cron, PluginBridge).
        main: wranglerMain(
          e.data.sources["/app/wrangler.jsonc"] ?? e.data.sources["/app/wrangler.json"],
        ),
      };
    }
    const built = await buildAstroApp({
      esbuild,
      progress: progressReporter(),
      release: async () => {
        await esbuild.stop();
        await esbuild.initialize({ wasmURL, worker: true });
      },
      transform,
      files,
      root: "/app",
      packages,
      log,
      ...extra,
    });
    log(
      `built in ${Math.round(performance.now() - t0)} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.inputs.length} inputs`,
    );
    await afterBuild();
    // The bundle as bytes, transferred: a string would be copied into the page while this
    // worker's own copy is still alive.
    const code = new TextEncoder().encode(built.code);
    postMessage(
      {
        code,
        routes: built.routes.length,
        clientAssets: built.clientAssets,
        modules: built.modules,
      },
      { transfer: [code.buffer] },
    );
  } catch (err) {
    await cleanup();
    postMessage({ error: (err as Error)?.stack ?? String(err) });
  }
};
