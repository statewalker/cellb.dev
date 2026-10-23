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

## celld vs workerd

No differences seen so far. workerd passes its own tests at the pinned commit by construction;
where celld does not, its answer is what is recorded, and the difference is listed here.

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
