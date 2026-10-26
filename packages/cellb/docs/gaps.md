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
| `wd-websocket-constructor-gaps` | `WebSocketPair` ends have no `binaryType` and always deliver `ArrayBuffer`s, whatever `websocket_standard_binary_type` says; Node's `WebSocket` takes `'BLOB'` as `'blob'`, and Chromium's `CloseEvent` keeps lone surrogates in a close reason. |
| `wd-worker-loader-gaps` | No plain-object `ctx.exports` entries; `WorkerCode.compatibilityFlags`, data and wasm module types, and Durable Object stubs in a loaded Worker's `env` or `props` are not supported. celld refuses `allowExperimental` and stub cloning, so most of these exports fail on celld as well. |
| `miniflare2-details-relative-url` | A stub's `fetch()` of a relative URL: celld passes it to the object, which fails on `new URL()`; cellb rejects at the stub, as workerd does. |

The `binaryType` default depends on a compatibility flag per project, but `WebSocketPair` is one
class shared by every project and reaches a project three ways (esbuild inject, the browser bundle,
the in-browser module server). A per-project default needs all three.

## RPC across isolates is poorer than workerd's

- An `RpcTarget` passed through a stub is refused with `RPC stubs cannot cross isolate boundaries
  yet.` (`src/core/namespace.ts`). Functions pass by reference only inside one runtime.
- A loaded Worker's isolate talks to its parent over `@statewalker/webrun-rpc`
  (`src/isolate/protocol.ts`). Errors keep their own properties (`name`, `code`), but request and
  response bodies are buffered whole, and values that cannot be cloned become stubs only as `env`
  entries — never as arguments, results or `props`. Passing one fails with `DataCloneError`.
- celld refuses the same things (`function () {} could not be cloned`, `Worker Loader env supports
  only Service Binding capabilities.`), so cellb matches the judge. workerd passes stubs.
  **Open decision:** keep celld's refusal, or follow workerd. Following workerd would make those
  cases disagree with the celld goldens and be judged against `conformance/golden-workerd/` instead.

## Planned work

Each item is proven by a conformance case changing state (a `knownGap` removed, or a new step
recorded on celld or workerd), not by a test of the mechanism alone.

- **Streamed bodies across an isolate**, instead of buffered copies.
- **Stubs by reference across isolates** (functions, `RpcTarget`, stubs as arguments, results, `env`
  and `props`) — only if the RPC decision above goes to workerd.
- **Small known gaps**, one at a time: `binaryType` per project; `WorkerCode` data and wasm modules;
  plain-object `ctx.exports`; `sql.ingest()` only if wanted.
- **Idle databases.** Hibernation drops a cell's instance but keeps its SQLite database open; a
  second, longer idle time should close it and reopen on the next event.
- **Storage round trips for Workflows and R2.** The interop suite already moves R2 objects
  celld → cellb → celld, and Workflow instances celld → cellb and cellb → celld as separate tests; a
  single celld → cellb → celld Workflow chain is not recorded.
- **Firefox and WebKit.** Only Chromium is tested. Module ServiceWorkers, OPFS synchronous handles
  and Web Locks are the likely failures; record them here before fixing anything.
- **Await the lease release on close.** Closing a runtime releases each cell without waiting, so a
  store closed right after can leave `own.json` held until the node lease lapses (10 s by default):
  the next node reports `owned by another node` until then.

## Other gaps

- **A persistent local database can overwrite another node's writes.** A runtime restores a cell
  from the bucket only when the cell's local SQLite database is empty. A node that kept its local
  file, lost the cell to another node, and takes it back later serves its old local state and logs
  it as the new generation: the other node's writes are lost. Seen with `nodeSqliteOpener(dir)` on a
  fleet bucket (node A counts 1, node B 2, node A again 2 instead of 3). The same applies to a
  browser runtime, whose OPFS pool persists, when it takes back a cell it lost. Until fixed, give a
  runtime on a fleet bucket local SQLite that starts empty: in memory, or a fresh directory or pool
  per start.
- **Configuration cellb does not support** is reported in `createProjectRuntime(...).unsupported`,
  not silently ignored: `migrations.renamed_classes`, `durable_objects.bindings[].script_name`,
  service bindings to other scripts, and compatibility flags it does not know.
- **Isolated facets in a browser are not in the fleet bucket.** `browserProjectRuntime` does not give
  its isolates the host's storage, so a Durable Object class of a loaded Worker keeps its database in
  the isolate's OPFS pool only. On Node they are logged through the parent.
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
