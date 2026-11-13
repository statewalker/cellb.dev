// Serves webrun-http-browser's ServiceWorker runtime at <base>sw-worker.js (the page passes that URL
// to hostSitesForWorker). Its scope is the sandbox's base path, so it can mount the site the runner
// worker asks for (the running app: its client and its server) under its own path there, and it
// stays clear of other ServiceWorkers on the origin (cellb.dev's homepage demo has scope "/").
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SW_FILE = "sw-worker.js";
// Around webrun's runtime: cross-origin isolation for the sandbox, as coi-serviceworker gives it.
// Every response this worker gives a page of its scope (the sandbox page, its workers, the running
// app in the preview) carries COOP same-origin and COEP credentialless, so the page and its
// workers get SharedArrayBuffer: Astro's compiler (compiler-rs as wasm32-wasi) needs a shared
// WebAssembly memory. Requests webrun's runtime leaves alone (the sandbox's own files) are
// fetched here for that. Cross-origin requests go to the network as they are (credentialless:
// no-cors loads without credentials, CORS ones as usual).
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
const source = async () =>
  `${PRELUDE}\n${await readFile(require.resolve("@statewalker/webrun-http-browser/sw-worker"), "utf8")}\n${POSTLUDE}`;

/** @returns {import("astro").AstroIntegration} */
export function swWorker() {
  return {
    name: "cellb-sandbox-sw-worker",
    hooks: {
      "astro:server:setup": ({ server }) => {
        const base = server.config.base.replace(/\/?$/, "/");
        server.middlewares.use(`${base}${SW_FILE}`, async (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(await source());
        });
      },
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL(`./${SW_FILE}`, dir), await source());
      },
    },
  };
}
