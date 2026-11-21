// The browser demos: a landing page, notebook/ (Lifo) and python/ (Wasmer).
//   dev:   vite --config examples/browser-demos/vite.config.ts
//   build: DEMOS_BASE=/demos/containers/ vite build --config …   (a static site in dist/)
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const require = createRequire(import.meta.url);
const base = process.env.DEMOS_BASE ?? "/";
const page = (path: string) => `${import.meta.dirname}/${path}`;

// The page's ServiceWorker, at <base>sw-worker.js (its scope is the app's folder): webrun-http-browser's
// runtime, which routes <base>nb/… to the page, inside a shim that gives every response of its
// scope cross-origin isolation (COOP same-origin, COEP credentialless), as coi-serviceworker does
// (the same shim as apps/sandbox's): a static host sends no such headers, and Lifo's mounts need
// SharedArrayBuffer. Requests webrun's runtime leaves alone are fetched here for that.
const PRELUDE = `
const __coiResponded = new WeakSet();
const __coi = (res) => {
  if (!res || res.status === 0 || res.type === "opaque" || res.type === "opaqueredirect") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
const __respondWith = FetchEvent.prototype.respondWith;
FetchEvent.prototype.respondWith = function (r) {
  __coiResponded.add(this);
  return __respondWith.call(this, Promise.resolve(r).then(__coi));
};
`;
const POSTLUDE = `
self.addEventListener("fetch", (e) => {
  if (__coiResponded.has(e)) return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  e.respondWith(fetch(e.request));
});
`;
const swWorker = () =>
  `${PRELUDE}\n${readFileSync(require.resolve("@statewalker/webrun-http-browser/sw-worker"), "utf8")}\n${POSTLUDE}`;

// @wasmer/sdk, unbundled, at <base>wasmer-sdk/ (dist/ and pkg/, as apps/sandbox ships it): its
// thread-pool workers import their sibling files by URL, which a bundler does not follow.
const wasmerSdk = dirname(dirname(require.resolve("@wasmer/sdk/browser")));
function sdkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(wasmerSdk, dir), { withFileTypes: true })) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sdkFiles(path));
    else if (!/\.(map|d\.ts)$/.test(e.name)) out.push(path);
  }
  return out;
}
const SDK_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
};

export default defineConfig({
  root: import.meta.dirname,
  base,
  // a cache of its own: the e2e server (same package) runs beside it under Playwright, and two
  // servers optimizing into one cache directory break each other's dependencies
  cacheDir: `${import.meta.dirname}/../../../node_modules/.vite-notebook`,
  plugins: [
    {
      name: "notebook-host",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // in dev the server sends the headers itself (the ServiceWorker adds them on a static host)
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          const path = req.url?.split("?")[0] ?? "";
          if (path.startsWith(`${base}wasmer-sdk/`)) {
            const file = join(wasmerSdk, path.slice(`${base}wasmer-sdk/`.length));
            if (!file.startsWith(wasmerSdk)) return next();
            try {
              res.setHeader("Content-Type", SDK_TYPES[extname(file)] ?? "application/octet-stream");
              res.end(readFileSync(file));
            } catch {
              next();
            }
            return;
          }
          if (path === `${base}sw-worker.js`) {
            res.setHeader("Content-Type", "text/javascript");
            res.end(swWorker());
            return;
          }
          next();
        });
      },
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "sw-worker.js", source: swWorker() });
        for (const file of [...sdkFiles("dist"), ...sdkFiles("pkg")])
          this.emitFile({
            type: "asset",
            fileName: `wasmer-sdk/${file}`,
            source: readFileSync(join(wasmerSdk, file)),
          });
      },
    },
  ],
  // No HMR client: Lifo takes its worker's console output as the running command's output.
  server: { hmr: false, fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] } },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: page("index.html"),
        notebook: page("notebook/index.html"),
        python: page("python/index.html"),
      },
    },
  },
  optimizeDeps: {
    entries: [
      "index.html",
      "notebook/index.html",
      "notebook/build-worker.ts",
      "notebook/run-worker.ts",
      "python/index.html",
      "python/wasmer-worker.ts",
    ],
  },
});
