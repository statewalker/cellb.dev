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
- **`alarm()` got no `scheduledTime`.** `alarmInfo.scheduledTime` is now the time the alarm was
  set for, kept across retries. p07a pins it too, so the two now overlap on retry semantics;
  p07a stays, because it also covers the input gate and retry backoff with a fake clock, which
  the upstream test does not.

## celld vs workerd

celld passes every vendored test. workerd passes its own tests at the pinned commit by
construction; where celld does not, its answer is what is recorded, and the difference is
listed here.

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

None. Only the configuration is translated (see Method).

## Not ported, and why

| Not ported | Why |
|---|---|
| workerd C++ tests (`io/actor-cache-test.c++`, `actor-sqlite-test.c++`, `io-gate-test.c++`, `hibernation-manager-test.c++`, `util/sqlite-*`) | Bound to workerd internals; read as a specification when a semantic question comes up |
| workerd's WPT harness and its streams, URL, encoding, blob, crypto, fetch tests | Those globals are the host's (Node or Chromium), not webrun-cells code. WebSocket, the one global implemented here, is covered by p07y |
| `kv-test`, `r2-test`, `queue-test`, `cache-*` | They test workerd's native binding clients against mock backend workers; our bindings are compared with celld (`kv*`, `r2*`, `queues*` projects) |
| `js-rpc-test` and the `*rpc*` family | They need a second worker script; the project loader binds only its own entrypoints |
| `actor-alarms-name-test`, tail/trace tests, `api/node/tests`, Python tests | `workerd:unsafe`, tail workers, host Node, Pyodide: workerd-only or not webrun-cells code |
| Miniflare 4's own test suite | It tests Miniflare's options and wiring; its simulators run unchanged here (p08a/b) |
| Miniflare v2's rwmutex, plugin, runner, http-server and shared-storage tests | Internal to Miniflare's design; p02 already runs every storage case on both SQLite drivers |
| celld's tests | None are published |
