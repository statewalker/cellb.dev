# Gaps

This is the list of what CellB does not do yet, or does differently from celld. Each entry says
what you see.

## Recorded celld behaviours CellB does not reproduce

Each is a `knownGap` scenario in `conformance/scenarios.ts`: the Node suite expects it to differ
from the celld golden, and turns red when it stops differing ([Conformance](conformance.md)).

| Scenario | What differs |
|---|---|
| `wd-sql-default` | CellB and celld stop at the same assertion, `sql.ingest()`'s syntax error, which CellB words as celld does (`sql-ingest` agrees), but celld's report of it carries celld's own stack frames. |
| `wd-actor-fetch-rejection` | No global `addEventListener('unhandledrejection')` in Node; celld's own `assert` rethrows its `rejected: … [at …]` error. |
| `wd-websocket-hibernation` | The other way round: celld fails this workerd test with an error that reads "got" followed by an empty value; CellB passes it, as workerd does. |
| `wd-websocket-constructor-gaps` | The host's own classes: Node's `WebSocket` takes `'BLOB'` as `'blob'`, and Chromium's `CloseEvent` keeps lone surrogates in a close reason. |
| `wd-worker-loader-gaps` | Exports of workerd's Worker Loader test that CellB or celld does not pass. CellB: `WorkerCode.compatibilityFlags`; `getDurableObjectClass(name, { props })` ignores its props; `facetUafRegression` needs `gc()`. celld: it refuses `allowExperimental` and stubs in `env`, so most of these exports fail on celld as well; `facets` fails there (`FacetStartupOptions.class must be a DurableObjectClass`); and in `nullGlobalOutbound` celld blocks the fetch, but its own `assert` rethrows the rejection as `rejected: … [at …]`. CellB's `globalOutbound: null` itself works (see `inheritGlobalOutbound` below). |
| `miniflare2-details-relative-url` | A stub's `fetch()` of a relative URL: celld passes it to the object, which fails on `new URL()`; CellB rejects at the stub, as workerd does. |

## Stubs pass by reference, as on workerd, except between nodes

- Functions, `RpcTarget`s and stubs pass by reference through a stub (`cross` in
  `src/core/handles.ts`) and into or out of a loaded Worker's isolate, in its `env`, `props`,
  arguments and results (`src/isolate/protocol.ts`). celld refuses them; these cases are judged
  against workerd ([Conformance](conformance.md#where-cellb-follows-workerd-instead)).
- **A call on a stub returns an RpcPromise**, as on workerd: `stub.a().b()` and
  `await stub.a().x.y` work before `a()` settles. Across an isolate's port `b` is sent at once,
  naming `a`'s pending answer; in one realm, and to an object on another node, `b` runs once `a()`
  settles. It is `instanceof Promise` but not a native promise, and it cannot be called itself
  (`stub.getFn()()` fails: await the function first). Only the first call on a loaded Worker's
  entrypoint result is pipelined across the isolate; a call on that call's result waits for it.
- **A stub into an isolate holds its value until released.** `stub[Symbol.dispose]()` or garbage
  collection of the stub releases it; then the value's own `Symbol.dispose` runs. A stub used after
  `Symbol.dispose` rejects with `A stub was used after it was disposed.`
- **Stubs do not cross to another node.** An object owned by another tab, worker or peer is called
  over cells-http or celld's tunnel with V8-serialized arguments and results: a function, `RpcTarget`
  or stub in either is refused with `DataCloneError: Functions, RpcTargets and stubs cannot be sent
  to another node: they pass by reference only within one runtime.` (`toAnotherNode` in
  `src/core/handles.ts`).
- **Only `ctx.exports.X({ props })` stubs and class handles can be stored** in Durable Object
  storage (as V8 host objects, `[name, props]`, restored against the Worker's `ctx.exports`). celld
  cannot read such a value; other stubs and `RpcTarget`s are refused with `DataCloneError`.
- A fetch into a loaded Worker crosses as HTTP/1.1, so hop-by-hop request headers (`Connection`,
  `TE`, `Keep-Alive`) do not reach it. WebSocket upgrades do: they cross on a channel of their own.

## Firefox and WebKit

`pnpm e2e:firefox` runs the browser suite in Firefox, and `pnpm e2e` stays on Chromium. A
`pnpm e2e:webkit` script exists, but WebKit is not run (see the last item below).
Module ServiceWorkers, OPFS synchronous access handles (the sahpool VFS), Web Locks and module
Dedicated Workers all work in Firefox 157, and the whole suite passes there. What differs
([Running in a browser](browser-host.md#firefox-and-webkit)):

- **Firefox has no `Request.body`, so CellB adds one that reads the whole body.** `createCellRuntime` installs a
  `request.body` that reads the body with `arrayBuffer()` on its first read, so Worker code gets a
  `ReadableStream`, but the whole body is in memory before the first chunk. Firefox stores a
  `ReadableStream` given as a request body as the text `[object ReadableStream]`, so Worker code
  that forwards one (`new Request(url, { body: request.body })`, `fetch(url, { body: … })`) sends
  that text. Use `await request.arrayBuffer()`, or the request itself, as the body.
- **WebKit is not tested, and is not a target for now.** Playwright's WebKit needs the system
  library `libavif16` (`libavif.so.16`), which the test machines do not have.

## Other gaps

- **Configuration CellB does not support** is reported in `createProjectRuntime(...).unsupported`,
  instead of being silently ignored: `migrations.renamed_classes`,
  `durable_objects.bindings[].script_name`, `containers`, service bindings to other scripts, the
  Workers AI binding (`ai`) when the host names no OpenAI-compatible endpoint for it, queue
  consumers without a `queue()` handler, cron triggers without a `scheduled()` handler, and
  compatibility flags it does not know. Renaming a Flue agent renames its class, so it needs
  `renamed_classes`. Browser tabs log it (`cellb: project … shard …: unsupported: …`).
- **On Node, the project's text `vars` do not overwrite `process.env`.** Under nodejs_compat from
  compatibility date 2025-04-01, both hosts fill `process.env` with them, as workerd does
  (`nodejs_compat_populate_process_env` and `nodejs_compat_do_not_populate_process_env` override
  the date). A Node host shares its real `process` with the Worker, so a variable the host process
  already set keeps its value there.
- **`waitUntil` of `cloudflare:workers` runs in the runtime's background** until `drain()`. It is
  not tied to the event that called it, since nothing in CellB cancels an event's work after its
  response.
- **`node:crypto` in a browser has no signature checks.** `createPublicKey` returns a `KeyObject`
  (type and DER/PEM export), but `verify` and `createVerify` throw, because a synchronous check
  would need a pure-JS implementation. `node:module`'s `require` serves only the built-ins CellB polyfills.
- **Workers AI is an OpenAI-compatible endpoint.** `env.AI.run()` serves text generation and
  embeddings through the host's `ai` endpoint, with Workers AI model ids mapped to its models;
  image, speech and classification models throw. `options.gateway` is ignored, and
  `env.AI.gateway()` throws.
- **`env` and `exports` of `cloudflare:workers` are empty in a Worker loaded into a site
  project's realm.** Every project gets its own. A loaded Worker gets its own too (its
  `WorkerCode.env` and stubs of its own entrypoints) on Node, in a browser bundle's realm, and in
  an isolate (`isolateScript`). On an in-browser site without `isolateScript`, the project and its
  loaded Workers share the realm's module registry. Its `cloudflare:workers` entry then answers
  according to the module that asks: it finds a loaded Worker's proxy (a module under
  `<site>loaded/`) on the stack and gives that code empty objects, and anything else that reads
  the entry gets the project's.
- **`cloudflare:email` only loads.** It exists so code that imports it at top level (the Agents SDK)
  starts, on Node and in browser bundles. Building an `EmailMessage` throws `cloudflare:email is
  not supported by cellb`. An in-browser site provides the module too.
- **`node:fs` and `node:os` in a browser have no host behind them.** With nodejs_compat a browser
  bundle gets `node:fs` whose calls fail with `ENOENT` (`existsSync` is false) and `node:os` with
  fixed answers (`EOL` is `"\n"`, no CPUs, no memory), so that libraries that probe for files can
  load. The one directory there is workerd's read-only `/bundle` (below).
- **`/bundle` in `node:fs` holds the bundle's non-JS modules only.** Under nodejs_compat, as on
  workerd, Worker code reads its modules from `/bundle`: each `.wasm`, Text or Data file the
  bundle imports, named as wrangler uploads it (`<sha1 of its bytes>-<file name>`), on Node and in
  browser bundles. A file is listed once its module has been evaluated (all of them, unless a
  dynamic `import()` delays one), and the JavaScript modules are not there: CellB bundles them
  into one. On Node, every other path is the host's real file system.
  Other Node.js modules without a browser polyfill (`node:child_process`, `node:readline`, …) load
  as stubs whose exports throw when called, as wrangler's nodejs_compat stubs do on Cloudflare.
- **`AsyncLocalStorage` in a browser carries its stores only through code it can see.** The
  `node:async_hooks` polyfill limits each `run()` to its synchronous part and makes continuations
  carry their stores (`Promise.prototype.then`, timers, `queueMicrotask`). A native `await`
  bypasses `then`, so with nodejs_compat `await` is lowered to generators. In a bundle,
  `bundleWorkerForBrowser` does this with esbuild; in a site's modules, `createProjectSite` does it
  with `lowerAwait`, after webrun-modules. Both then behave as on Node
  (`test/async-context-worker.ts` checks 16 objects at once). Some code is not lowered: the awaits
  of async generators, async functions that use `super` or `new.target` (on a site only; esbuild
  lowers those too), and top-level await. Such code resumes in no store after an `await`, rather
  than in another event's store. In a browser with TC39 AsyncContext (Stage 2, not shipped by any
  browser yet), the polyfill is a layer over `AsyncContext.Variable` and `Snapshot` instead. Sites
  then lower nothing (`bundleWorkerForBrowser` takes `lowerAwait: false`), and the engine carries
  the stores through native awaits as workerd and celld do. `enterWith()` throws there
  (`test/p18-native-async-context.test.ts` runs this on an AsyncContext built from Node's own).
  Event listeners (`addEventListener`, MessagePort `onmessage`) do not carry stores, on Node
  either.
- **An object's events start in the async context the runtime was made in.** A call to an object
  is a new event, as on Cloudflare: the callee (and its constructor) does not see the caller's
  `AsyncLocalStorage` stores. Where Cloudflare has none, CellB has the stores that were current
  when `createCellRuntime` ran, so a host can scope a whole runtime
  (`test/p09-celld-conformance.test.ts` attributes each scenario's logs this way). On Node this needs `process.getBuiltinModule` (Node 22.3 and later);
  in a browser it goes through CellB's `node:async_hooks` polyfill.
- **A browser runtime is one thread, and OPFS writes take most of its time.** Its cells
  interleave, and each commit's SQLite I/O is synchronous on that thread. A Flue conversation turn (a prompt, a tool
  call, two model turns) makes 21 commits. In a CI-like container an OPFS write costs about
  0.75 ms whatever its size, and those writes are about 80% of the worker's time. To use more threads, spread the project over
  several workers (`startProjectShards`). There, 32 Flue conversations take 16 s on one worker and
  11 s on four, because four workers writing OPFS at once slow each other down. With
  `joinProjectShards`, the tabs of an origin share the shards, split evenly and moved as tabs come
  and go, while cells are still placed in shards by hash. Opening a cell reserves room in the OPFS
  pool first, and the pool grows on demand. A database or journal that SQLite creates mid-event
  can still fail with `SAH pool is full` if a burst outruns the background growth.
- **The `WebSocket` global of Worker code is workerd's, built over the host's.** Its prototype is
  the server-side socket's (`serializeAttachment`, `deserializeAttachment`: partyserver and the
  Agents SDK reach attachments through it), it has the `READY_STATE_*` statics, and `instanceof`
  covers both ends of a `WebSocketPair` and client sockets. `new WebSocket(url)` returns the host's
  own client socket, so a class that extends the global gets a host socket, not an instance of
  itself. Its `Request` global carries `Upgrade` and `Sec-WebSocket-*` into copies of a request,
  which a browser's `new Request()` drops; the host's own requests count as instances of it.
- **workerd's Worker Loader test `inheritGlobalOutbound` is not run.**
  `WorkerCode.globalOutbound` itself is implemented: `null` blocks `fetch`, and a Fetcher
  redirects it, both in the host's realm and in an isolate, where the request crosses back to the
  host. It matches celld in the `runtime-api` project and passes `overrideGlobalOutbound` in
  `wd-worker-loader`. `inheritGlobalOutbound` cannot be run here: it needs the test Worker's own
  `globalOutbound`, a `.wd-test` setting with no wrangler equivalent, so on celld and CellB it
  would fetch `https://example.com` for real.
- **An OPFS fleet bucket has one writer at a time.** Its conditional writes are checked first and
  written afterwards, so two tabs using it at once can both win.
- **`Set-Cookie` cannot reach a page** through a ServiceWorker, and a browser `Response` drops it.
- **The input gate does not hold timers, as on celld.** A timer set before
  `blockConcurrencyWhile()` fires while its callback runs; workerd holds it until the callback
  ends. `wd-actor-block-concurrency-timer` records celld doing the same as CellB, and that
  scenario is judged against celld.
  workerd's input gate also defers outbound `fetch` completions while storage is in flight; CellB
  does not, and what celld does there is not recorded.
- **Some celld examples are not run.** These are `python` (Pyodide Python Workers, and CellB runs
  no Python), `wasm` (it needs the Rust toolchain to build), and `container` and `sandbox` (they
  need Docker or Podman; a `containers` config is reported in `unsupported`). As celld ships them,
  `pi` and `opencode` need a model on the network. `examples/agents` runs both against a fake
  OpenAI-compatible model, adapted to take their model from an endpoint in their vars.
- **The LTX store's room check is a hint.** Before a compaction it compares the cell's size with
  `navigator.storage.estimate()`, which overstates the room in a Playwright (off-the-record)
  context, where OPFS lives in memory with its own limit. A write past the limit still fails
  cleanly (`storage quota exceeded writing …`), with nothing left half-written.
- **The LTX log of fleet buckets keeps each cell's pages in memory.** `ltxLog`
  (`src/bucket/ltx-log.ts`, behind `celldBucket` and `filesApiLtxLog`) holds the pages it last
  wrote per cell; `bucket: { ltx }` reads a cell page by page instead.
- **The workspace runs CellB from its TypeScript sources**, while the published package runs from
  `dist/` (`publishConfig.exports`). `scripts/pack-check.mjs` checks the built package in CI, so a
  change that only breaks the build shows up there and not in the workspace's tests.

## Out of scope, on purpose

- **Limits per object** (CPU time, memory, storage size).
- **Opaque-origin iframes for untrusted code.** A loaded Worker is isolated from the project's realm,
  not from the origin.
- **celld's log tier and capacity hand-off (`/peer/handoff`).** A CellB node acknowledges a write
  only once it is in the bucket and never accepts cells it was not asked for.
- **Python Workers.**
