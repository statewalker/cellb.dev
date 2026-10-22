# 21 — Isolated loaded Workers, routing between nodes, Node.js compatibility, and the rest

All behaviours below were compared with the real celld 0.6.2 (conformance projects), in
Node and in Chromium (Node-built bundles and the in-browser HTTP server), unless stated.

## Isolation of loaded Workers

celld runs every Worker-Loader Worker in its own V8 isolate. Project `isolation-api` shows it:
loaded code does not see the host's globals or env, its own global writes do not leak back,
and its env is exactly what its `WorkerCode` declares — plain values and service stubs.
webrun-cells used to run loaded code in the host's realm (mismatch on both points).

Now each loaded Worker runs in **its own realm** — a worker thread on Node, a Dedicated Worker
in browsers — behind one MessagePort (`src/isolate/`):

| | |
|---|---|
| Code | Node: bundled with esbuild (cloudflare:workers bundled in), imported from a `data:` URL in the thread. Browser: imported from the in-browser HTTP server, or as Blob-URL modules inside the isolate |
| env | structured-cloneable values are copied; anything else (stubs, bindings) becomes a stub whose method calls go back to the host |
| fetch / RPC | serialized requests/responses and structured-cloned arguments over the port |
| Logs | sent to the host, which prints them and feeds Tail Workers. In browsers loaded modules get their own console — the realm's global one is left alone (the dev server logs there) |
| `globalOutbound: null` | the isolate's global `fetch` throws |
| Durable Object classes (facets) | still loaded in the host's realm: their storage API is synchronous and cannot cross a port |

`isolation-api`, `facets`, `dynamic-worker-tails`, `runtime-api` match celld everywhere.

## Routing between nodes

`createCellRuntime({ ownership, peers: { ownerOf, link } })`: a node that cannot own a cell
(`CellOwnedElsewhereError`, possibly wrapped as a broken-object cause) forwards the call to
the lease holder over an internal link — `cellsHttpHandler` on the far side, so `fetch` and
JS RPC both travel. `CasLease.holder(name)` reads the holder; closing a host releases its
lease so ownership moves at once. Test (`p10c`): two nodes behind real `node:http` links
with a shared secret; requests and RPC on the non-owner are served by the owner; when the
owner closes, the other node takes the cell and restores it from the log.

## Node.js compatibility (`nodejs_compat`)

Project `node-compat` (Buffer, crypto, events, path, util, AsyncLocalStorage, process). Node
hosts: `node:*` are Node itself. Browsers: npm polyfills (buffer, events, path-browserify,
util) plus ours (crypto on @noble/hashes, run-scoped AsyncLocalStorage, process); `Buffer` and
`process` also become globals. celld itself does not implement `URL` from `node:url`.
webrun-modules resolves `node:*` to its jspm polyfills before host-provided names, so the
in-browser server serves them under aliases — an upstream change would remove that.

## Also added

- HTMLRewriter on Miniflare's `html-rewriter-wasm`, vendored as an ESM module with async WASM
  loading: async handlers work (`html-rewriter`, `html-rewriter-async`).
- Static assets `force-trailing-slash` / `drop-trailing-slash`; `.assetsignore` refused as by
  celld. celld 0.6.2 answers 404 for every path ending in `/` except the root — a bug; those
  requests are left out of the comparison and unit-tested against Cloudflare's behaviour.
- Cron catch-up: after downtime, one missed occurrence (the latest) runs.
- D1 migrations (`applyD1Migrations`) with celld's/wrangler's rules.
- Queues `max_concurrency`, which exposed a real bug: a re-armed alarm could run while its
  handler was still running, delivering queue messages twice. Now one `alarm()` at a time per
  object (as on Cloudflare), and messages are leased while delivered.

## Test totals

Unit: 233 passed, 2 skipped. Chromium: 57 runtime tests + 37 projects × 2 browser paths, all
passed (the 2-second Workflow sleep in `workflow-api` keeps it deterministic under load).

## Ids identical to celld's

celld derives ids in Rust (`engine_api.rs`): namespace key
`cells:v1:<len(script)>:<script>:<class>` (fleet-wide keys for KV, D1 and Queues), key =
SHA-256(namespace key), id = HMAC(key, name)[0..16] ‖ HMAC(key, first half)[0..16]; the second
half authenticates the first, so `idFromString()` refuses ids of another namespace
("Durable Object ID is not valid for this namespace"); `ctx.id.name` only for names ≤ 1024
UTF-8 bytes. webrun-cells now derives the same bytes (`do-ids` project: identical hex ids),
which makes objects addressable identically on both — a precondition for sharing storage.
HTTP links address by name whenever the id came from a name; remote runtimes receive the
namespace keys in the describe handshake.

## D1 and storage details (`d1-details`)

Sessions return the bookmark `celld:primary`; results report `served_by_primary: true` and
`served_by_region: "local"`; a read-only statement reports `last_row_id` and `changes` as 0;
ATTACH/DETACH and TEMP objects are "not authorized", VACUUM "authorization denied", BEGIN in
`exec()` fails as celld's; fts5 works. celld has **no** Durable Object bookmark API
(`getCurrentBookmark` etc. are not functions) — webrun-cells now matches, keeping the methods
only on its D1 simulator, which needs them. Point-in-time recovery is therefore not a gap.

## Still missing

Python Workers, isolation for Durable Object classes, real LTX segments (a VFS hook in
SQLite WASM), webrun-modules' provided-before-builtin order.
