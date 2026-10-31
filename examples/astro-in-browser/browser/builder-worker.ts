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
  return {
    download(ref: { pkg: string; version?: string }) {
      const x = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      const id = next++;
      x.busy++;
      return new Promise<{ name: string; version: string }>((resolve, reject) => {
        waiting.set(id, (r) => {
          waiting.delete(id);
          x.busy--;
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
    close: () => workers.forEach((x) => x.w.terminate()),
  };
}
async function readText(files: { read(p: string): AsyncIterable<Uint8Array> }, path: string) {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  return chunks.length
    ? new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])))
    : undefined;
}

self.onmessage = async (
  e: MessageEvent<{ sources: Record<string, Uint8Array>; integrations?: boolean }>,
) => {
  try {
    const t0 = performance.now();
    await esbuild.initialize({ wasmURL, worker: false });
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
      const cache = httpFiles(e.data.store);
      const pool = downloadPool(DOWNLOADERS, e.data.store);
      const source = cachedSource(cache, npmRegistrySource() as never, undefined, pool.download);
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
        pool.close();
      };
    }
    let extra = {};
    if (e.data.integrations) {
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
        session: {
          driver: "unstorage/drivers/cloudflare-kv-binding",
          options: { binding: "SESSION" },
        },
      };
    }
    const built = await buildAstroApp({
      esbuild,
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
    postMessage({
      code: built.code,
      routes: built.routes.length,
      clientAssets: built.clientAssets,
    });
  } catch (err) {
    postMessage({ error: (err as Error)?.stack ?? String(err) });
  }
};
