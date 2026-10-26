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
| `wd-websocket-hibernation` | The other way round: celld fails this workerd test (`got `); cellb passes it, as workerd does. |
| `wd-websocket-constructor-gaps` | The host's own classes: Node's `WebSocket` takes `'BLOB'` as `'blob'`, and Chromium's `CloseEvent` keeps lone surrogates in a close reason. |
| `wd-worker-loader-gaps` | `WorkerCode.compatibilityFlags`; `abortIsolateDynamic*` do not build; `getDurableObjectClass(name, { props })` ignores its props; `facetUafRegression` needs `gc()`. celld refuses `allowExperimental`, so most of these exports fail on celld as well. |
| `miniflare2-details-relative-url` | A stub's `fetch()` of a relative URL: celld passes it to the object, which fails on `new URL()`; cellb rejects at the stub, as workerd does. |

## Stubs pass by reference, as on workerd, except between nodes

- Functions, `RpcTarget`s and stubs pass by reference through a stub (`cross` in
  `src/core/handles.ts`) and into or out of a loaded Worker's isolate, in its `env`, `props`,
  arguments and results (`src/isolate/protocol.ts`). celld refuses them; these cases are judged
  against workerd ([conformance.md](conformance.md#where-cellb-follows-workerd-instead)).
- **There is no promise pipelining**: `stub.a().b()` waits for `a()` before calling `b()`.
- **A stub into an isolate holds its value until released.** `stub[Symbol.dispose]()` or garbage
  collection of the stub releases it; then the value's own `Symbol.dispose` runs. A stub used after
  `Symbol.dispose` rejects with `A stub was used after it was disposed.`
- **Stubs do not cross to another node.** An object owned by another tab, worker or peer is called
  over cells-http or celld's tunnel with V8-serialized arguments and results: a function, `RpcTarget`
  or stub in either is refused with `DataCloneError: Functions, RpcTargets and stubs cannot be sent
  to another node: they pass by reference only within one runtime.` (`toAnotherNode` in
  `src/core/handles.ts`).
- **A loaded Worker's `globalOutbound` Fetcher does not route its `fetch()` in an isolate.** The
  isolate sees it only as `env.__outbound`; its global `fetch` is the realm's own (`null` still
  blocks it). Loaded in the host's realm, the Fetcher does route `fetch()`.
- **Only `ctx.exports.X({ props })` stubs and class handles can be stored** in Durable Object
  storage (as V8 host objects, `[name, props]`, restored against the Worker's `ctx.exports`). celld
  cannot read such a value; other stubs and `RpcTarget`s are refused with `DataCloneError`.
- A fetch into a loaded Worker crosses as HTTP/1.1, so hop-by-hop request headers (`Connection`,
  `Upgrade`, `TE`, `Keep-Alive`) do not reach it.

## Planned work

Each item is proven by a conformance case changing state (a `knownGap` removed, or a new step
recorded on celld or workerd), not by a test of the mechanism alone.

- **Small known gaps**, one at a time: `sql.ingest()` only if wanted.

## Firefox and WebKit

`pnpm e2e:firefox` runs the browser suite in Firefox; `pnpm e2e` stays on Chromium. (`pnpm e2e:webkit`
is wired, but WebKit is not run: see the last item.)
Module ServiceWorkers, OPFS synchronous access handles (the sahpool VFS), Web Locks and module
Dedicated Workers all work in Firefox 157. What fails, by cause (error text and the specs in
[browser-host.md](browser-host.md#firefox-and-webkit)):

- **Firefox has no `Request.body`; cellb gives it one, read whole.** `createCellRuntime` installs a
  `request.body` that reads the body with `arrayBuffer()` on its first read, so Worker code gets a
  `ReadableStream`, but the whole body is in memory before the first chunk. Firefox stores a
  `ReadableStream` given as a request body as the text `[object ReadableStream]`, so Worker code
  that forwards one (`new Request(url, { body: request.body })`, `fetch(url, { body: … })`) sends
  that text. Use `await request.arrayBuffer()`, or the request itself, as the body.
- **A clone error reads differently:** SpiderMonkey's `Function object could not be cloned.` against
  V8's (and celld's) `() => 1 could not be cloned.`
- **Under Playwright's Firefox, a page loaded while a ServiceWorker is active is not controlled**;
  only `clients.claim()` takes it. The sharded topology's second tab therefore talks to the dev
  server instead of the router. Whether Firefox outside Playwright does the same is not checked.
- **WebKit is not run, and is not a target for now:** Playwright's WebKit needs the system
  `libavif16` (`libavif.so.16`), which this host lacks.

## Other gaps

- **Configuration cellb does not support** is reported in `createProjectRuntime(...).unsupported`,
  not silently ignored: `migrations.renamed_classes`, `durable_objects.bindings[].script_name`,
  service bindings to other scripts, the Workers AI binding (`ai`), and compatibility flags it
  does not know. A Flue app (packages/flue-example) leaves out Flue's `cloudflare` provider for
  that reason; renaming a Flue agent renames its class, so it needs `renamed_classes`.
- **`env` and `exports` of `cloudflare:workers` exist for a project's own Worker only, and in a
  browser only for a bundle.** A Node project and a browser bundle (`bundleWorkerForBrowser`) get
  the project's own; a project on an in-browser site (`code: { site }`) does not, because the site's
  module registry is shared with its loaded Workers, which must not see the project's bindings.
  Loaded Workers get empty objects, except one run in its own Node thread, where `import { env }
  from "cloudflare:workers"` fails to build (`No matching export`).
- **`cloudflare:email` only loads.** It exists so code that imports it at top level (the Agents SDK)
  starts, on Node and in browser bundles; building an `EmailMessage` throws `cloudflare:email is not
  supported by cellb`. An in-browser site does not provide it.
- **`node:fs` and `node:os` in a browser have no host behind them.** With nodejs_compat a browser
  bundle gets `node:fs` whose calls fail with `ENOENT` (`existsSync` is false) and `node:os` with
  fixed answers (`EOL` is `"\n"`, no CPUs, no memory); they let libraries that probe for files load.
- **`AsyncLocalStorage` in a browser carries its stores only through code it can see.** The
  `node:async_hooks` polyfill keeps each `run()` to its synchronous part and makes continuations
  carry their stores (`Promise.prototype.then`, timers, `queueMicrotask`); a native `await` bypasses
  `then`, so `bundleWorkerForBrowser` lowers `await` to generators in nodejs_compat bundles. A
  bundle then answers as on Node (test/async-context-worker.ts, 16 objects at once). An in-browser
  site's modules are compiled without lowering, so there the polyfill keeps its run-at-a-time
  stores: a `run()`'s store stays set until its promise settles, which is right for one run at a
  time and shared between concurrent ones (two cells answering at once can read each other's).
  Event listeners (`addEventListener`, MessagePort `onmessage`) do not carry stores, on Node either.
- **A called object starts in its caller's async context.** Its `AsyncLocalStorage` stores are the
  caller's (on Node and in a browser), where on Cloudflare a call to another object is a new event
  with none. The Agents SDK and Flue set their own stores at each entry, so they are not affected;
  code that reads a store it did not set in the callee sees the caller's. Changing it means
  starting each event in the root context, which the celld conformance harness (test/p09) relies
  on not doing: it attributes Durable Object logs to a scenario through such a store.
- **A browser runtime is one thread.** Its cells interleave, they do not run in parallel, and each
  commit's SQLite I/O is synchronous on that thread. A Flue conversation turn (a prompt, a tool call,
  two model turns) makes about 155 commits, so concurrent conversations in one runtime take turns
  (the sharded topology spreads cells over several workers). Opening a cell reserves room in the
  OPFS pool first and the pool grows on demand; a database or journal that SQLite creates mid-event
  (`SAH pool is full`) can still fail if a burst outruns the background growth.
- **Agents SDK WebSocket connections are ignored.** `partyserver` reads attachments through the
  global `WebSocket.prototype` (`deserializeAttachment`), which a Worker's bundle takes from the
  host and which lacks them, so it does not recognise any accepted socket as its own: `onConnect`
  and `onMessage` never run. Flue's own routes use HTTP and SSE and are not affected.
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
