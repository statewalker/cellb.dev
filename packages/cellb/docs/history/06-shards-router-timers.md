# 06 — P05 ownership: one ServiceWorker router, sharded workers; worker-timers & workerpool

## Library evaluations

### chrisguttandin/worker-timers (8.0.34) — not needed for cells, maybe for a page-side clock
- Drop-in `setTimeout/setInterval/clear*` that schedule inside a Worker spawned from a
  Blob (`load-or-return-broker.ts`). Its README states the reason: background throttling
  applies to the **main thread only, not to Web Workers**.
- Cells (and P07 alarms) run in **shard workers**, whose native timers are already
  unthrottled → worker-timers adds nothing there.
- It **cannot run in a ServiceWorker** (probe: `typeof Worker === "undefined"` in SW
  scope). A SW is also killed when idle, so it must never own alarm timers anyway.
- Does not help with the real alarm problem: frozen/discarded/closed tabs. Alarms still
  need persistence in `_cf_METADATA` + catch-up when a shard is (re)opened (P07).
- Where it fits: an injectable `Clock` port (P07) — `{ now, setTimeout, clearTimeout }`
  — native in workers/Node, worker-timers if a scheduler ever lives on a page's main thread.

### josdejong/workerpool (10.0.3) — not a fit for Durable Objects
- A stateless **task pool**: `Pool._getWorker()` returns the first worker that is not
  `busy()`; a worker runs one task at a time; no affinity. DOs need the opposite:
  every event for a cell must reach the one worker hosting it, and several events must
  interleave inside that worker at `await` points (input-gate semantics).
- Creates workers itself (`new Worker` / `worker_threads`) → cannot be driven from a
  ServiceWorker; exposes no MessagePort to hand a worker to another context.
- Kept in mind for: crash detection/restart patterns, and offloading CPU-heavy
  stateless helpers on the server.

## What was built instead (P05a/b)

**Findings that shaped it (Chromium probes).**
- `opfs-sahpool` is **exclusive per pool name**: a second worker opening the same pool
  fails with `NoModificationAllowedError` (access handle already open); a different pool
  name opens fine. → storage must be partitioned, one pool per worker.
- ServiceWorker scope has `navigator.locks` and `MessageChannel`, but no `Worker` or
  `SharedWorker`.

**Model: fixed shards.** `shardOf(idHex, N)`; a shard = one Web Lock
(`webrun-cells:shard:i`) = one opfs-sahpool (`webrun-cells-shard-i`) = one Dedicated
Worker. Changing N needs a migration.

**Components.**
- `CellRouter` (runtime-agnostic; lives in the SW here, Node main thread in tests):
  `attach(shard, send)` (last writer wins), `ingress(req)` (public: control headers
  stripped, round-robin to a live shard's Worker `fetch`), `internal(req)` (DO → DO:
  routed by `shardOf`). Missing shard → `onMissingShard` + wait, 503/error on timeout.
- `createShardHost` (in each worker): runtime whose new `route` hook keeps own-shard cells
  local and sends others upstream; `link(down, up)` can be called again after a router
  restart.
- Page: `navigator.locks.request` per shard; only the lock holder spawns that shard's
  worker, wires two MessageChannels (router→shard, shard→router) and posts the router ends
  to the SW. On `cells-need-links` from a restarted SW it re-attaches.

**Verified.**
- Node (3 `worker_threads` shards, router in main thread): placement by shard, DO → DO
  across shards, input gate with 10 concurrent callers from two other shards, restart of a
  shard with queued requests completing after re-attach, timeout error. 51 unit tests.
- Chromium (2 shards, router in a module ServiceWorker):
  - objects spread over both shards, stable placement, cross-shard `bump`;
  - second tab is queued on both locks (checked with `navigator.locks.query()`), is served
    by tab 1's workers, then takes over when tab 1 closes — OPFS data intact;
  - `ServiceWorker.stopAllWorkers` (CDP): the new SW instance asks pages to re-attach and
    the request that triggered it succeeds.
- Browser mutation harness (`npm run mutate:browser`): 3/3 killed (no re-attach request,
  no Web Lock, no OPFS). Red phase caught a weak spec: closing tab 1 after 300 ms let a
  lock-less tab 2 open the pools *after* tab 1 closed; the spec now asserts lock queueing.

**Lessons / open.**
- ServiceWorker as the single server works, but every SW restart drops all ports; latency
  of the first request after a restart = message round-trip to a page + re-link. If no
  page is open, nothing can serve (by design in the browser).
- Last-attach-wins is safe only because Web Locks prevent two live owners; the router
  does not fence. Server side (P05c) needs a real lease with epoch fencing (S3 conditional
  writes) behind the same `attach` contract.
- A dead tab's port is not detected: in-flight requests to it hang until the new owner
  attaches. Needs a per-call timeout or `getPortCloseSignal` from webrun-rpc.
- The Worker module's stateless `fetch` runs in whichever shard ingress picked; it could
  run in the SW itself later (no DOs there, just routing).

**Code.** `src/core/shard.ts`, `src/router/{cell-router,shard-host}.ts`, `route` option in
`src/core/runtime.ts`, `browser/sharded/*`; tests `test/p05-router.test.ts`,
`test/shard-worker.entry.ts`, `browser/e2e/sharded.spec.ts`, `scripts/mutate-browser.mjs`.
