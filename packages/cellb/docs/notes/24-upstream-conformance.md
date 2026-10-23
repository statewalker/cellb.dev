# 24 — Upstream conformance: workerd's Durable Object tests, unchanged

**Goal.** Until now every expectation webrun-cells is held to was either written here
(p02, p03, p07a …) or recorded from celld (the conformance projects, note 17). celld
publishes no tests of its own; it checks itself against **workerd's Durable Object contract
tests** (`src/workerd/api/tests`). Running those same files here puts upstream-written
assertions on webrun-cells, judged the same way as everything else: against celld.

## Method

`scripts/vendor-workerd-tests.mjs` copies each upstream `*-test.js` byte-identical (below one
provenance line) into a wrangler project `conformance/workerd-tests/wd-<name>/`, next to a
`wrangler.jsonc` and a generated `index.js`:

- **Runner.** `GET /` calls every `test(ctrl, env, ctx)` export in module-namespace order and
  answers `{ exportName: "ok" | "timeout" | "<Error>: <first line>" }`. The order is fixed by
  the spec (`Object.keys` of a module namespace is sorted), so celld and webrun-cells run the
  exports in the same order — which matters, because exports share object names
  (`idFromName("A")`). A 5 s per-export timeout keeps one hanging test (an alarm that never
  fires) from hiding the others. `?skip=a,b` leaves exports out, to split a known gap into a
  scenario of its own.
- **Configuration by hand, not a Cap'n Proto converter.** A `.wd-test` is workerd's config
  language; the part that matters here is a few lines (flags, Durable Object bindings, text
  bindings), written once into the script's `WD_TESTS` table. Tail workers and test disks
  are workerd instrumentation and are dropped. Every class gets SQLite storage, whatever the
  `.wd-test` says: celld and webrun-cells have no in-memory backend.
- **Oracle.** The scenario is one `GET /`; `conformance/record-celld.ts` records celld 0.6.2's
  answer into `conformance/golden/wd-<name>.json`, and p09 requires webrun-cells to answer the
  same. A test that fails on celld fails the same way here, or the difference shows.

A project that does not load (an import webrun-cells lacks, such as a `workerd:*` module)
fails p09 at once with the bundler's error, not by timing out.

## Results

| Project | Upstream file | celld 0.6.2 | webrun-cells (Node) |
|---|---|---|---|
| `wd-actor-kv` | `actor-kv-test.js` | `default: ok` | same |
| `wd-sync-kv` | `sync-kv-test.js` | `testAutoRollBackOnCriticalError: ok` | same, after the fixes below |
| `wd-delete-all-deletes-alarm-enabled` | `delete-all-deletes-alarm-test.js` (`delete_all_deletes_alarm`) | `test: ok` | same |
| `wd-delete-all-deletes-alarm-disabled` | same file (`delete_all_preserves_alarm`) | `test: ok` | same, after the fixes below |
| `wd-sql-restrict-names` | `sql-restrict-names-test.js` | `default: ok` | same, after the fixes below |
| `wd-actor-alarms` | `actor-alarms-test.js` | `test: ok` | same, after the fixes below |
| `wd-actor-alarms-delete` | `actor-alarms-delete-test.js` | `default: ok` | same |
| `wd-actor-alarms-in-memory` | `actor-alarms-in-memory-test.js` | `clearAfterAlarm: ok`, `updateDuringAlarm: ok` | same |
| `wd-sql` (all but `default`) | `sql-test.js` | `testMultiStatement: ok`; `testRollbackKvInit` fails (the alarm set in a rolled-back `transactionSync()` survives); no `getCurrentBookmark()`, no `gc` | same, after the fixes below |
| `wd-sql-default` (`default` only) | same file | stops at `sql.ingest()`'s syntax-error message | **known gap**: no `sql.ingest()` |
| `wd-actor-block-concurrency-depth` | `actor-block-concurrency-depth-test.js` | `default: ok` | same, after the fixes below |
| `wd-actor-block-concurrency-timer` | `actor-block-concurrency-timer-test.js` | fails: the timer set before `blockConcurrencyWhile()` fires during it | same |
| `wd-actor-stub` | `actor-stub-test.js` | fails: `get(id, { retry })` is not validated | same, after the fixes below |
| `wd-actor-fetch-rejection` | `actor-fetch-rejection-test.js` | `handledRejection` fails with celld's wrapped error; `unhandledRejection: timeout` | **known gap**: no global `addEventListener('unhandledrejection')` in Node |
| `wd-stub-storage` | `stub-storage-test.js` | both fail: celld cannot clone the stubs it is asked to store | **known gap**: no `ctx.exports.<Entrypoint>({ props })` stubs |
| `wd-websocket-hibernation` | `websocket-hibernation.js` | fails (`Error: got `) | **known gap** the other way round: passes, as workerd does |
| `wd-websocket-constructor` (13 of 18 exports) | `websocket-constructor-test.js` | all `ok` | same, after the fixes below |
| `wd-worker-loader` (6 exports) | `worker-loader-test.js` | `asyncCodeLoader`, `codeLoaderException`, `passEnv`, `passEnvCaps`, `startupException: ok`; `suggestWorkerBundlerForTypeScriptModules` fails | same, after the fixes below |
| `wd-worker-loader-gaps` (14 exports) | same file | mostly failing on celld too (no `allowExperimental`, no stub cloning) | **known gap**, see below |
| `wd-websocket-constructor-gaps` (the other 5) | same file | all `ok` | **known gap**: `WebSocketPair` ends have no `binaryType` and always deliver ArrayBuffers; the host's `WebSocket` (Node) and `CloseEvent` (Chromium) deviate |
| `miniflare2-details` (`/storage`, `/stub`) | Miniflare v2 `storage.spec.ts`, `namespace.spec.ts`: the behaviours they covered, recorded as observations (their assertions are not copied) | `undefined` keys and values, `start` with `startAfter`, uncommitted reads in transactions, `put()` then `deleteAll()` in one turn; a stub's `fetch()` takes `ftp:` URLs, a non-`Response` return (as `"[object Object]"`, 200) and returns mutable headers | same, after the fixes below |
| `miniflare2-details-relative-url` | same | the object receives `/x` and fails on `new URL()`; the rejection carries its stack frames | **known gap**: rejected at the stub, as workerd |

Chromium answers the same on both paths (the esbuild bundle and the in-browser module server).
On the module server, `import * as assert from "node:assert"` needed webrun-modules 0.3.4 and
the realm's registry entries passed to `createProjectSite` (`nodeModules`).

What the upstream tests found in webrun-cells, each fixed in its own commit:

- **`delete_all_preserves_alarm` was ignored.** `deleteAll()` always cleared the alarm; the
  flag now flows from `wrangler.jsonc` to `ctx.storage`.
- **DDL on `_cf_` names was allowed.** `CREATE`/`DROP` of a `_cf_*` object now throws celld's
  `SQL error: prepare SQL cursor: not authorized`.
- **No `scheduler` global.** `scheduler.wait(ms)` is now a worker global (Node and browser).
- **`ctx.exports.<Class>` lacked the namespace methods** under `enable_ctx_exports`: it now
  carries `idFromName`, `get`, `getByName` … of the bound namespace.
- **More than one live `kv.list()` iterator.** A new `kv.list()` call now invalidates the
  previous iterator, with workerd's message.
- **`alarm()` got no `scheduledTime`.** `alarmInfo.scheduledTime` is now the time of the stored
  alarm row being handled (for a retry, the time it was rescheduled to). p07a pins it too, so the
  two overlap; p07a stays, because it also covers the input gate and retry backoff with a fake
  clock, which the upstream test does not (it checks only a first run).
- **`SELECT "foo"` was an error.** celld and workerd read a double-quoted name that is no column
  as a string (SQLite's DQS); both SQLite drivers now do too.
- **A cursor's last `next()` had a `value` key.** It is now `{ done: true }`, as in workerd.
- **`blockConcurrencyWhile()` nested without limit.** The 65th nested call now throws
  `blockConcurrencyWhile() calls are nested too deeply.` at once, as in workerd and celld.
- **A stub had `fetch` and an internal symbol as own enumerable keys.** `Object.keys(stub)` is
  now `[id, name]`, and two stubs of one object are deep-equal.
- **`const [client, server] = new WebSocketPair()` threw.** The pair is now iterable.
- **The client's `binaryType` took any value.** Only `"blob"` and `"arraybuffer"` are taken now.
- **On the module server, `import assert from "node:assert"` was not callable.** A `node:*`
  registry entry is now the module's default export (`assert`, `EventEmitter`, `process`),
  carrying the named exports as properties.
- **An object's `fetch()` returning a non-`Response` reached the caller as that value.** As in
  celld, the stub now answers with it as text (`String(value)`, status 200); found by
  `miniflare2-details`.

**What `worker-loader-test.js` shows webrun-cells lacks** (`wd-worker-loader-gaps`):
`ctx.exports.<Entrypoint>({ props })` stubs and plain-object exports in `ctx.exports`;
`WorkerCode.compatibilityFlags` (loaded code always sees Node's `process`, and never sees one in
Chromium); data and wasm module types; Durable Object stubs passed in `env` or `props`.
**`WorkerCode.globalOutbound` is ignored**: a loaded worker that the caller meant to redirect
reaches the real network instead. `overrideGlobalOutbound` is left out of the vendored runs for
that reason, since it would really fetch https://example.com. Also left out: the shared/unique
loader ids (wrangler's `worker_loaders` have no `id`), the test's own `globalOutbound`, and the
Python and Tail exports. workerd is not recorded for this project: `record-workerd.ts` maps no
`worker_loaders`.

`binaryType` depends on a flag. With `websocket_standard_binary_type`, celld's pair and client
sockets default to `"blob"` and deliver Blobs; without it, they default to `"arraybuffer"`
(probed by hand). webrun-cells' `WebSocketPair` is one class shared by every project, and its
globals reach a project three ways (esbuild inject, the browser bundle, the module server).
A per-project default therefore needs plumbing on all three paths: a follow-up, kept visible
as `wd-websocket-constructor-gaps`.

`sql-test.js` is split. Its four critical-error exports are not run: they shrink the database
with `setMaxPageCountForTest`, a workerd test hook celld refuses, so they mean nothing outside
workerd. `default`, which is most of the file, needs the experimental `sql.ingest()`, which
webrun-cells lacks. It is a `knownGap` scenario of its own, so the other exports are still
compared. Even with `ingest`, it would only agree with celld up to celld's failure at an ingest
error message. A failed assertion is compared by its `AssertionError` name only, because Node's
`assert` and celld's word the same failure differently.

**How failures are compared.** The runner reports a failed assertion by its fields, as
`AssertionError: <actual> <operator> <expected>`, not by its message. Node's `assert`, the npm
polyfill in Chromium and celld's own `assert` word the same failure differently, but they agree
on those fields. The Chromium bundle keeps function names (esbuild `keepNames`), because the
polyfill reports its caller's name as the operator. A test that reports a time (`wd-sql`) masks
epoch milliseconds.

## celld vs workerd

`conformance/record-workerd.ts` runs every scenario on workerd through Miniflare 4 (pinned
devDependency `miniflare`, 4.20260730.0), writes `conformance/golden-workerd/`, and compares
with celld's golden. Only Durable Objects and `vars` are mapped: a project with KV, D1, R2,
queues, workflows, assets, Worker Loaders, services, cron triggers or the celld-only
`sqlite_vec` flag is skipped, since those are simulators (celld's, Miniflare's), not workerd.
celld stays the target; each disagreement is pinned with a one-line `workerdDiffers`, and an
entry that no longer differs fails the run.

| Result | Projects |
|---|---|
| agrees | the 8 storage and alarm `wd-*` projects, `wd-actor-block-concurrency-depth`, `wd-actor-stub`, `wd-websocket-constructor`, `wd-websocket-constructor-gaps`, hello, webapi, counter, rpc, router, body, async, alarm, alarm-retry, wsecho, wsclient, html-rewriter, html-rewriter-async, node-compat, kv-values |
| differs (`workerdDiffers`) | `do-ids` (per-deployment id keys; message punctuation), `storage-details` (celld stores `undefined`, coerces `setAlarm(non-date)`, needs no `alarm()` handler; SQL error texts), `worker-details` (celld's JSON "Worker failed" body, non-`Response` returns accepted, no cross-isolate RPC stubs), `ws-details` (`Error` vs `TypeError`; `send()` before `accept()`), `wd-sql` (workerd has `getCurrentBookmark()` and rolls the alarm back), `wd-sql-default` (workerd runs it up to `gc()`), `wd-actor-block-concurrency-timer` (workerd holds the earlier timer at the input gate; its run outlasts the 5 s limit), `wd-actor-fetch-rejection` (workerd reports unhandled rejections), `wd-stub-storage` (workerd stores stubs), `wd-websocket-hibernation` (workerd passes), `miniflare2-details` (workerd refuses `start` with `startAfter`, `ftp:` URLs, non-`Response` returns and header mutation), `miniflare2-details-relative-url` (workerd rejects at the stub) |
| skipped | 23 projects with non-DO bindings, and `vectordb` (`sqlite_vec`) |

The vendored flags drop the ones workerd refuses to see listed at our `compatibility_date`
(defaults by then): `rpc` and `enable_ctx_exports` in `wd-sync-kv`, and
`streams_enable_constructors` and `transformstream_enable_standard_constructor` in `wd-sql`,
`enable_ctx_exports` in `wd-actor-stub`, and `rpc`, `enable_ctx_exports` and
`fetcher_no_get_put_delete` in `wd-stub-storage`.
celld answers the same without them.

## Known differences from celld (not covered by an upstream test)

Probed by hand on celld 0.6.2 while porting `sql-restrict-names-test.js`; the upstream test
exercises none of these, so p09 does not see them:

| Statement | celld | webrun-cells |
|---|---|---|
| `SELECT` from `_cf_KV` | `not authorized`, naming the column (`_cf_KV.scope`) | same message, but `_cf_METADATA` reports `.key` where celld says `.scope` |
| a column named `_cf_col` | allowed | rejected |
| a string literal `'_cf_x'` | allowed | rejected |
| `ALTER TABLE … RENAME TO _cf_t2` | allowed | rejected |

webrun-cells is stricter in the last three; none of them changes what a Durable Object that
keeps out of `_cf_` names sees.

## Ported with changes

None of the upstream files. Only the configuration is translated (see Method), and some
exports are left out with a stated reason (`skip` in the script's `WD_TESTS` table).

## Not ported, and why

| Not ported | Why |
|---|---|
| workerd C++ tests (`io/actor-cache-test.c++`, `actor-sqlite-test.c++`, `io-gate-test.c++`, `hibernation-manager-test.c++`, `util/sqlite-*`) | Bound to workerd internals; read as a specification when a semantic question comes up |
| workerd's WPT harness and its streams, URL, encoding, blob, crypto, fetch tests | Those globals are the host's (Node or Chromium), not webrun-cells code. WebSocket, the one global implemented here, is covered by p07y |
| `kv-test`, `r2-test`, `queue-test`, `cache-*` | They test workerd's native binding clients against mock backend workers; our bindings are compared with celld (`kv*`, `r2*`, `queues*` projects) |
| `js-rpc-test` and the `*rpc*` family | They need a second worker script; the project loader binds only its own entrypoints |
| `actor-alarms-name-test`, tail/trace tests, `api/node/tests`, Python tests | `workerd:unsafe`, tail workers, host Node, Pyodide: workerd-only or not webrun-cells code |
| Miniflare 4's own test suite | It tests Miniflare's options and wiring; its simulators run unchanged here (p08a/b) |
| Miniflare v2's rwmutex, plugin, runner, http-server and shared-storage tests | Internal to Miniflare's design; p02 already runs every storage case on both SQLite drivers. The storage and namespace behaviours its `durable-objects` tests checked are recorded on celld instead (`miniflare2-details`) |
| celld's tests | None are published |
