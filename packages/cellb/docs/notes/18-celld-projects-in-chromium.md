# 18 — The celld projects in Chromium

**Goal.** Run the same 24 projects as the Node comparison (18 celld examples + 6 of ours),
from the same `wrangler.jsonc`, on webrun-cells **inside Chromium**, and get the same
transcripts and user logs as the real celld 0.6.2 (`conformance/golden/`).

**Result: 24/24 match** (`browser/e2e/celld-projects.spec.ts`, Chromium 153 packaged in
`node_modules` by `@sparticuz/chromium`).

## How a project runs in the browser

1. **Bundle (Node side, like `celld deploy`)** — `conformance/browser-bundle.ts` bundles
   `main` with esbuild for a browser realm. `cloudflare:workers` and the Workers globals
   (`Response` that accepts status 101, `WebSocketPair`) are virtual modules that read host
   registries (`globalThis.__cellsWorkersModule`, `__cellsGlobals`) — the webrun-modules
   `~deps` idea applied at bundle time. Asset files travel with it.
2. **Run (Chromium)** — `browser/projects/project-worker.ts`, one fresh Dedicated Worker per
   project: the bundle is imported from a Blob URL, cells use SQLite WASM on **OPFS**
   (sahpool, one pool per run), KV values and R2 objects live in an **OPFS FilesApi**,
   `createProjectRuntime()` builds the bindings from the config (same code as on Node), the
   scenario runs in the worker, and user `console` output is captured as celld prints it.
3. **Compare (Node side)** — transcript and logs against celld's golden, with the same two
   documented alignments as on Node (no Content-Type for string bodies on celld;
   Content-Length added as celld's HTTP server does).

## What the browser needed beyond Node

| Need | Solution |
|---|---|
| Worker Loader (facets, dynamic-worker-tails) without a bundler in the page | `src/project/browser-modules.ts`: each loaded module becomes a Blob-URL ES module; `cloudflare:workers` → shim URL; relative imports → sibling Blob URLs; a module-scoped `console` feeds Tail Workers |
| `sqlite_vec` (vectordb) — WASM cannot load extensions at run time | a SQLite WASM build with sqlite-vec compiled in (`sqlite-vec-wasm-demo`); `WasmSqliteDriver.loadExtension` only checks it is there. **0.1.7–0.1.9 abort at init** (Emscripten assertion "Attempt to set Module.postRun"); **0.1.6 works** and gives celld's exact distances |
| Outbound `fetch` from a Workflow step to the reference server | the reference server sends `Access-Control-Allow-Origin` (browser CORS; celld, a server, needs none) |
| Outbound WebSocket from a Durable Object (wsclient) | the browser's own `WebSocket` |

## Timings (Chromium, sequential)

24 projects ≈ 3.5 min, dominated by `cron` (one real minute), `queues` (25 s of retries and
dead-lettering), `workflow-api`, `alarm`.

## Open threads

- The project runner is a test harness (bundle in Node, run in a worker). A product needs the
  bundling step in the browser too (webrun-modules in the ServiceWorker, as in note 13).
- Projects here run in ONE worker; the sharded topology (ServiceWorker router + shard
  workers + Web Locks) is exercised by `sharded.spec.ts` / `websocket.spec.ts`, not by this
  corpus yet.
- sqlite-vec WASM is pinned to 0.1.6 until a newer build initialises.
