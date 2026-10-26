# Gaps

This is the list of what cellb does not do yet, or does differently from celld, as of the current
code. Each entry says what you see. When a gap closes, its entry goes, in the same commit.

## Recorded celld behaviours cellb does not reproduce

Each is a `knownGap` scenario in `conformance/scenarios.ts`: the Node suite expects it to differ
from the celld golden, and turns red when it stops differing ([conformance.md](conformance.md)).

| Scenario | What differs |
|---|---|
| `wd-sql-default` | `sql.ingest()` (experimental) does not exist. celld itself stops at an ingest syntax-error message, so even with it the two agree only up to there. |
| `wd-actor-fetch-rejection` | No global `addEventListener('unhandledrejection')` in Node; celld's own `assert` rethrows its `rejected: … [at …]` error. |
| `wd-stub-storage` | No storable `ctx.exports.<Entrypoint>({ props })` stubs. celld refuses to clone them too, differently. |
| `wd-websocket-hibernation` | The other way round: celld fails this workerd test (`got `); cellb passes it, as workerd does. |
| `wd-websocket-constructor-gaps` | The host's own classes: Node's `WebSocket` takes `'BLOB'` as `'blob'`, and Chromium's `CloseEvent` keeps lone surrogates in a close reason. |
| `wd-worker-loader-gaps` | No plain-object `ctx.exports` entries; `WorkerCode.compatibilityFlags` and Durable Object stubs in a loaded Worker's `env` or `props` are not supported. celld refuses `allowExperimental` and stub cloning, so most of these exports fail on celld as well. |
| `miniflare2-details-relative-url` | A stub's `fetch()` of a relative URL: celld passes it to the object, which fails on `new URL()`; cellb rejects at the stub, as workerd does. |

## RPC across isolates is poorer than workerd's

- An `RpcTarget` passed through a stub is refused with `RPC stubs cannot cross isolate boundaries
  yet.` (`src/core/namespace.ts`). Functions pass by reference only inside one runtime.
- A loaded Worker's isolate talks to its parent over `@statewalker/webrun-rpc`
  (`src/isolate/protocol.ts`). Errors keep their own properties (`name`, `code`) and bodies stream,
  but values that cannot be cloned become stubs only as `env` entries — never as arguments, results
  or `props`. Passing one fails with `DataCloneError`. A fetch into a loaded Worker crosses as
  HTTP/1.1, so hop-by-hop request headers (`Connection`, `Upgrade`, `TE`, `Keep-Alive`) do not
  reach it.
- celld refuses the same things (`function () {} could not be cloned`, `Worker Loader env supports
  only Service Binding capabilities.`), so cellb matches the judge. workerd passes stubs.
  **Open decision:** keep celld's refusal, or follow workerd. Following workerd would make those
  cases disagree with the celld goldens and be judged against `conformance/golden-workerd/` instead.

## Planned work

Each item is proven by a conformance case changing state (a `knownGap` removed, or a new step
recorded on celld or workerd), not by a test of the mechanism alone.

- **Stubs by reference across isolates** (functions, `RpcTarget`, stubs as arguments, results, `env`
  and `props`) — only if the RPC decision above goes to workerd.
- **Small known gaps**, one at a time: plain-object `ctx.exports`; `sql.ingest()` only if wanted.

## Firefox and WebKit

`pnpm e2e:firefox` and `pnpm e2e:webkit` run the browser suite there; `pnpm e2e` stays on Chromium.
Module ServiceWorkers, OPFS synchronous access handles (the sahpool VFS), Web Locks and module
Dedicated Workers all work in Firefox 157. What fails, by cause (error text and the specs in
[browser-host.md](browser-host.md#firefox-and-webkit)):

- **Firefox has no `Request.body`.** Worker code that reads `request.body` gets `undefined`: celld's
  `kv` and `r2` examples store nothing, Miniflare's KV simulator throws. Firefox also stores a
  `ReadableStream` given as a request body as the text `[object ReadableStream]`.
- **Three cellb paths still read `req.body`**, untested in Firefox: a request retried at the owner
  after `CellOwnedElsewhereError` is not cloned first (`src/core/runtime.ts`), a request whose
  scheme is restored from `x-cellb-proto` is rebuilt from `req.body` (`src/transport/cells-http.ts`),
  and so is a request given a new URL on an isolate's port (`withUrl`, `src/isolate/protocol.ts`).
  In Firefox all three would send an empty body.
- **`@statewalker/webrun-site-host` drops request bodies in Firefox** for the same reason, so the
  Worker Loader's uploads to an in-browser site arrive empty and every loaded Worker exports
  nothing. Projects bundled into the worker are not affected.
- **A clone error reads differently:** SpiderMonkey's `Function object could not be cloned.` against
  V8's (and celld's) `() => 1 could not be cloned.`
- **Under Playwright's Firefox, a page loaded while a ServiceWorker is active is not controlled**;
  only `clients.claim()` takes it. The sharded topology's second tab therefore talks to the dev
  server instead of the router. Whether Firefox outside Playwright does the same is not checked.
- **WebKit was not run:** Playwright's WebKit needs `libavif.so.16` (`apt-get install libavif16`),
  which this host lacks.

## Other gaps

- **Configuration cellb does not support** is reported in `createProjectRuntime(...).unsupported`,
  not silently ignored: `migrations.renamed_classes`, `durable_objects.bindings[].script_name`,
  service bindings to other scripts, and compatibility flags it does not know.
- **Isolated facets in a browser are not in the fleet bucket.** `browserProjectRuntime` does not give
  its isolates the host's storage, so a Durable Object class of a loaded Worker keeps its database in
  the isolate's OPFS pool only. On Node they are logged through the parent.
- **An isolated facet restores only into an empty database.** A Durable Object class of a loaded
  Worker runs in the isolate's own runtime, which holds no cell lease, so taking the root cell does
  not rebuild the facet's local database from the bucket as it does for the root and its local
  facets. On Node the isolate's SQLite is in memory (its opener takes a `dataDir` that nothing sets
  yet), so it starts empty and is restored correctly; an isolate given a persistent directory would
  serve the facet's old local state after taking a cell back and log it over the newer one.
- **The upstream Worker Loader exports `overrideGlobalOutbound` and `inheritGlobalOutbound` are left
  out** of the vendored run. `WorkerCode.globalOutbound` itself is implemented (`null` blocks
  `fetch`; a Fetcher redirects it) and matches celld in the `runtime-api` project; the comment in
  `scripts/vendor-workerd-tests.mjs` that calls it ignored is out of date.
- **An OPFS fleet bucket has one writer at a time.** Its conditional writes are checked, then
  written; two tabs using it at once can both win.
- **`Set-Cookie` cannot reach a page** through a ServiceWorker, and a browser `Response` drops it.
- **`bufferedAmount` is always 0** on cellb's WebSockets: there is no backpressure on socket ports.
- **The input gate does not hold non-storage I/O.** A timer or `fetch` completion can interleave
  with another event while the gate is closed. celld behaves the same; workerd does not
  (`wd-actor-block-concurrency-timer`).
- **celld examples not run:** `python` (Pyodide Python Workers), `wasm` (needs the Rust toolchain to
  build), `container` and `sandbox` (Docker or Podman), `pi` and `opencode` (outbound access to model
  endpoints).
- **No build step.** The entry points are TypeScript sources. A bundler, Vite or vitest resolves
  them; plain `node` fails with `ERR_MODULE_NOT_FOUND` for `src/…/*.js`.

## Out of scope, on purpose

- **Limits per object** (CPU time, memory, storage size).
- **Opaque-origin iframes for untrusted code.** A loaded Worker is isolated from the project's realm,
  not from the origin.
- **celld's log tier and capacity hand-off (`/peer/handoff`).** A cellb node acknowledges a write
  only once it is in the bucket and never accepts cells it was not asked for.
- **Python Workers.**
