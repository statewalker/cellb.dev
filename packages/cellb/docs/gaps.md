# Gaps

This is the list of what cellb does not do yet, or does differently from celld, as of the current
code. Each entry says what you see. When a gap closes, its entry goes, in the same commit.

## Recorded celld behaviours cellb does not reproduce

Each is a `knownGap` scenario in `conformance/scenarios.ts`: the Node suite expects it to differ
from the celld golden, and turns red when it stops differing ([conformance.md](conformance.md)).

| Scenario | What differs |
|---|---|
| `wd-sql-default` | cellb and celld stop at the same assertion, `sql.ingest()`'s syntax error, which cellb words as celld does (`sql-ingest` agrees), but celld's report of it carries celld's own stack frames. |
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
  `Upgrade`, `TE`, `Keep-Alive`) do not reach it.

## Firefox and WebKit

`pnpm e2e:firefox` runs the browser suite in Firefox; `pnpm e2e` stays on Chromium. (`pnpm e2e:webkit`
is wired, but WebKit is not run: see the last item.)
Module ServiceWorkers, OPFS synchronous access handles (the sahpool VFS), Web Locks and module
Dedicated Workers all work in Firefox 157, and the whole suite passes there. What differs
([browser-host.md](browser-host.md#firefox-and-webkit)):

- **Firefox has no `Request.body`; cellb gives it one, read whole.** `createCellRuntime` installs a
  `request.body` that reads the body with `arrayBuffer()` on its first read, so Worker code gets a
  `ReadableStream`, but the whole body is in memory before the first chunk. Firefox stores a
  `ReadableStream` given as a request body as the text `[object ReadableStream]`, so Worker code
  that forwards one (`new Request(url, { body: request.body })`, `fetch(url, { body: … })`) sends
  that text. Use `await request.arrayBuffer()`, or the request itself, as the body.
- **WebKit is not run, and is not a target for now:** Playwright's WebKit needs the system
  `libavif16` (`libavif.so.16`), which this host lacks.

## Other gaps

- **Configuration cellb does not support** is reported in `createProjectRuntime(...).unsupported`,
  not silently ignored: `migrations.renamed_classes`, `durable_objects.bindings[].script_name`,
  service bindings to other scripts, the Workers AI binding (`ai`) when the host names no
  OpenAI-compatible endpoint for it, and compatibility flags it does not know. Renaming a Flue
  agent renames its class, so it needs `renamed_classes`.
- **Workers AI is an OpenAI-compatible endpoint.** `env.AI.run()` serves text generation and
  embeddings through the host's `ai` endpoint, with Workers AI model ids mapped to its models;
  image, speech and classification models throw, and `options.gateway` (AI Gateway) is ignored.
- **`env` and `exports` of `cloudflare:workers` are empty in a Worker loaded into a site
  project's realm.** Every project gets its own, and a loaded Worker gets its own (its
  `WorkerCode.env`, and stubs of its own entrypoints) on Node, in a browser bundle's realm, and in
  an isolate (`isolateScript`). On an in-browser site without `isolateScript` the project and its
  loaded Workers share the realm's module registry: its `cloudflare:workers` entry answers by the
  module that asks (a loaded Worker's proxy is a module under `<site>loaded/`, found on the
  stack), and gives loaded code empty objects; anything else that reads the entry gets the
  project's.
- **`cloudflare:email` only loads.** It exists so code that imports it at top level (the Agents SDK)
  starts, on Node and in browser bundles; building an `EmailMessage` throws `cloudflare:email is not
  supported by cellb`. An in-browser site provides it too.
- **`node:fs` and `node:os` in a browser have no host behind them.** With nodejs_compat a browser
  bundle gets `node:fs` whose calls fail with `ENOENT` (`existsSync` is false) and `node:os` with
  fixed answers (`EOL` is `"\n"`, no CPUs, no memory); they let libraries that probe for files load.
  Other Node.js modules without a browser polyfill (`node:child_process`, `node:readline`, …) load
  as stubs whose exports throw when called, as wrangler's nodejs_compat stubs do on Cloudflare.
- **`AsyncLocalStorage` in a browser carries its stores only through code it can see.** The
  `node:async_hooks` polyfill keeps each `run()` to its synchronous part and makes continuations
  carry their stores (`Promise.prototype.then`, timers, `queueMicrotask`); a native `await` bypasses
  `then`, so with nodejs_compat `await` is lowered to generators: by `bundleWorkerForBrowser`
  (esbuild) in a bundle, by `createProjectSite` (`lowerAwait`, after webrun-modules) in a site's
  modules. Both then answer as on Node (test/async-context-worker.ts, 16 objects at once). Not
  lowered: async generators' own awaits, async functions that use `super` or `new.target` (on a
  site; esbuild lowers those too), and top-level await; code there resumes in no store after an
  `await`, rather than in another event's. In a browser with TC39 AsyncContext (Stage 2, shipped
  by none yet) the polyfill is a layer over `AsyncContext.Variable` and `Snapshot` instead, sites
  lower nothing (`bundleWorkerForBrowser` takes `lowerAwait: false`), and the engine carries the
  stores through native awaits as workerd and celld do; `enterWith()` throws there
  (test/p18 runs it on an AsyncContext made of Node's own). Event listeners (`addEventListener`, MessagePort
  `onmessage`) do not carry stores, on Node either.
- **An object's events start in the async context the runtime was made in.** A call to an object
  is a new event, as on Cloudflare: the callee (and its constructor) does not see the caller's
  `AsyncLocalStorage` stores. Where Cloudflare has none, cellb has the stores that were current
  when `createCellRuntime` ran, so a host can scope a whole runtime (test/p09 attributes each
  scenario's logs this way). On Node this needs `process.getBuiltinModule` (Node 22.3 and later);
  in a browser it goes through cellb's `node:async_hooks` polyfill.
- **A browser runtime is one thread, and OPFS writes are its cost.** Its cells interleave, and
  each commit's SQLite I/O is synchronous on that thread. A Flue conversation turn (a prompt, a tool
  call, two model turns) makes 21 commits (155 when commits ended with each microtask); in this
  repository's CI-like container an OPFS write costs about 0.75 ms whatever its size, and those
  writes are about 80% of the worker's time. For parallel threads, spread the project over
  several workers (`startProjectShards`): 32 Flue conversations take 16 s on one worker and 11 s on
  four there, where four workers writing OPFS at once slow each other's writes. With
  `joinProjectShards`, the tabs of an origin share the shards (an even split, moved as tabs come
  and go); placement of cells within the shards stays by hash. Opening a cell reserves
  room in the OPFS pool first and the pool grows on demand; a database or journal that SQLite
  creates mid-event (`SAH pool is full`) can still fail if a burst outruns the background growth.
- **The `WebSocket` global of Worker code is workerd's, built over the host's.** Its prototype is
  the server-side socket's (`serializeAttachment`, `deserializeAttachment`: partyserver and the
  Agents SDK reach attachments through it), it has the `READY_STATE_*` statics, and `instanceof`
  covers both ends of a `WebSocketPair` and client sockets. `new WebSocket(url)` returns the host's
  own client socket, so a class that extends the global gets a host socket, not an instance of
  itself. Its `Request` global carries `Upgrade` and `Sec-WebSocket-*` into copies of a request,
  which a browser's `new Request()` drops; the host's own requests count as instances of it.
- **The upstream Worker Loader export `inheritGlobalOutbound` is left out** of the vendored run.
  `WorkerCode.globalOutbound` itself is implemented (`null` blocks `fetch`; a Fetcher redirects
  it, in the host's realm and in an isolate, where the request crosses back to the host), matches
  celld in the `runtime-api` project, and passes `overrideGlobalOutbound` in `wd-worker-loader`.
  `inheritGlobalOutbound` stays out for good: it needs the test Worker's own `globalOutbound`, a
  `.wd-test` setting with no wrangler equivalent, so on celld and cellb it would fetch
  `https://example.com` for real.
- **An OPFS fleet bucket has one writer at a time.** Its conditional writes are checked, then
  written; two tabs using it at once can both win.
- **`Set-Cookie` cannot reach a page** through a ServiceWorker, and a browser `Response` drops it.
- **The input gate does not hold timers, as on celld.** A timer set before
  `blockConcurrencyWhile()` fires while its callback runs; workerd holds it until the callback
  ends. `wd-actor-block-concurrency-timer` records celld doing the same as cellb, and celld is the
  judge, so this stays (following workerd would need a `judge: "workerd"` reason of the stub kind).
  workerd's input gate also defers outbound `fetch` completions while storage is in flight; cellb
  does not, and what celld does there is not recorded.
- **celld examples not run:** `python` (Pyodide Python Workers: cellb runs no Python), `wasm`
  (needs the Rust toolchain to build), `container` and `sandbox` (Docker or Podman; a `containers`
  config is reported in `unsupported`). `pi` and `opencode` need a model on the network as celld
  ships them; `examples/agents` runs both, adapted to take their model from an endpoint in
  their vars, against a fake OpenAI-compatible model.
- **No build step.** The entry points are TypeScript sources. A bundler, Vite or vitest resolves
  them; plain `node` fails with `ERR_MODULE_NOT_FOUND` for `src/…/*.js`.

## Out of scope, on purpose

- **Limits per object** (CPU time, memory, storage size).
- **Opaque-origin iframes for untrusted code.** A loaded Worker is isolated from the project's realm,
  not from the origin.
- **celld's log tier and capacity hand-off (`/peer/handoff`).** A cellb node acknowledges a write
  only once it is in the bucket and never accepts cells it was not asked for.
- **Python Workers.**
