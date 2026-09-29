# 07 — Server-side leases, liveness of owners, ServiceWorker restarts

Open issues from notes/06: (1) server-side lease, (2) requests hanging on a dead tab's
port, (3) ServiceWorker restarts dropping every port, (4) nothing serves when no tab is
open. Each hypothesis below was checked by a probe or a test.

## 1. How Wrangler / Miniflare do it

- **Miniflare 2** (the TS engine of Wrangler 2): no cross-process ownership at all —
  one `wrangler dev` process, one in-memory/file storage.
- **Miniflare 4 / wrangler today** (workers-sdk @ 087ea32, `shared/DEV_REGISTRY.md`,
  `dev-registry.ts`): a **filesystem registry** in `~/.wrangler/registry/`. Each process
  writes a JSON file per worker and *touches its mtime* as a heartbeat (10 s; stale after
  90 s). DO stubs of another process's classes go through proxy classes that dial the
  owner's workerd debug port (Cap'n Proto).
  For *shared storage* (opt-in) processes register "storage candidates" (heartbeat 2 s,
  expiry 10 s); **the oldest live candidate owns** KV/D1/R2; graceful shutdown stops the
  runtime before withdrawing. **User Durable Objects are deliberately kept per-process**
  ("never mount the shared owner root concurrently").
- So: TTL heartbeats on files, no OS locks, **no fencing**. Fine for dev tools; not a
  safety guarantee (a paused process can still write after its entry expired).

## 2. Server-side lease — two implementations behind one port

`Lease.tryAcquire(name) → { epoch, lost: AbortSignal, release() }` (`src/lease/lease.ts`).
`epoch` is the fencing token every durable write must carry (P06).

### Single host: SQLite file locks (probe `npm run probes:node`)
| Hypothesis | Result |
|---|---|
| H1 cell DB in `locking_mode=EXCLUSIVE`: another **process** can neither read nor write | ✅ `database is locked` on both |
| H2 `kill -9` of the holder frees the lock at once (OS drops fcntl locks) | ✅ read + write succeed |
| H3/H5 another **thread** (same or other process) is excluded too | ✅ |
| H4 a lease file with an open `BEGIN IMMEDIATE`: contender refused; freed on `kill -9` | ✅ |

- `SqliteFileLease` (`src/adapters/sqlite-lease.ts`): one `.lease.sqlite` per shard in
  EXCLUSIVE mode; the lock outlives `COMMIT`; the file stores the epoch (+1 per holder).
  No stale-lock heuristics, unlike lockfiles or mtime heartbeats.
- **Storage-level fencing:** `nodeSqliteOpener(dir, { exclusive: true })` opens every
  cell DB in EXCLUSIVE mode — a second process cannot even read a live owner's cell.
  Test: owner process serves `x`; intruder process gets `Durable Object reset because
  its initialization failed: database is locked`; after `kill -9` of the owner, a new
  process serves `x` with state intact.
- Found on the way: a failing `blockConcurrencyWhile()` (here: the locked DB in the
  constructor) was an unhandled rejection that killed the process. Now, as on
  Cloudflare, it **resets the object**: queued events reject with `BrokenObjectError`
  carrying the cause, the next call builds a fresh instance.
- Limits: local filesystems only (fcntl locks over NFS/SMB are unreliable); one host.

### Across hosts: CAS on a conditional store (S3 `If-None-Match` / `If-Match`)
`CasLease` (`src/lease/cas-lease.ts`) over `ConditionalStore { get, put(key, body, cond) }`:
- acquire = `If-None-Match: *` (absent) or `If-Match: etag` once `expiresAt + skew` has
  passed **on the taker's clock**; epoch + 1;
- renew every `renewEveryMs` with `If-Match`; 412 → `lost` ("taken over");
- **local deadline**: the holder aborts `lost` at `lastRenew + ttl − skew` even when the
  store is unreachable — it stops serving before anyone may take over;
- timing is not enough under GC/VM pauses → `FencedManifest`: a new holder `claim`s the
  shard manifest (epoch bump, new ETag); any later write of a paused ex-holder fails
  its `If-Match` → `FencedError`.
- Tests with a fake clock: single holder with renewals; partitioned holder stops before
  takeover; same for a holder partitioned before its first renewal; concurrent takers —
  exactly one wins; fencing of a paused ex-holder; same contract on
  `SqliteConditionalStore` (shared SQLite file = several processes, one host).
- **Not verified here:** a real bucket (no S3/R2/MinIO reachable from this sandbox).
  S3 and R2 document conditional writes; the adapter over webrun-files needs an
  ETag-aware `put` (FilesApi has none today).

Choice: same host → SQLite file lease (+ exclusive cell files); several hosts or a
shared bucket → CasLease + FencedManifest. Both satisfy the same port.

## 3. Dead owners: requests hanging on a dead port

- Probe A (Chromium 153): **no `close` event on MessagePort** (`onclose` absent; nothing
  fires when the other side's worker is terminated) — consistent with webrun-rpc's
  `close-signal.ts`.
- Probe B: a **pending Web Lock request on a lock held by the owner** is granted
  14 ms after the owner's tab closes.
- Design: each shard worker holds a lock of its own,
  `webrun-cells:owner:<shard>:<uuid>` (released by the browser when the worker or its tab
  dies); the page sends that name with `cells-attach`; the router's `watchOwner(shard,
  token)` requests it and detaches the shard when granted. Polling `isAlive`
  (`navigator.locks.query()`) stays as a 5 s safety net; Node uses worker `exit`.
- Replacing a shard's link (new owner) also fails the old link's in-flight requests.
- Failed in-flight requests surface as `ShardOwnerLostError` ("may or may not have
  been applied") → 503 at ingress. No automatic retry (not idempotent in general).
- Measured (e2e, owner tab closed 400 ms into a 15 s request): fails **~30–50 ms after
  the close** — both with and without a successor. Before: ~490 ms after the close when
  a successor had to attach first (887 ms total), ~30 ms + up to 500 ms polling otherwise
  (431 ms total). The spec asserts < 300 ms while polling is 5 s, so only the
  lock watch can pass it (browser mutant "no watch" is killed).

## 4. ServiceWorker restarts

- Measured with `ServiceWorker.stopAllWorkers` (CDP): first request after a restart
  **~46–56 ms** vs **~17 ms** warm — the cost of `cells-need-links` → page re-link.
- Probe C (idle termination, heartbeat as keep-alive): **inconclusive** — under
  Playwright the SW survived 45 s idle and 105 s total (Playwright/CDP attachment
  likely keeps it alive). Keep-alive by page heartbeats remains a hypothesis; the
  restart path is what matters and it is tested.
- Possible improvement (not done): the page re-links proactively on
  `controllerchange` / SW `activate`, before the first request.

## 5. No tab open

Inherent to browsers: without a page there is no Dedicated Worker, hence no sync OPFS
access and no SQLite. A ServiceWorker alone cannot host cells (no `Worker`, and sync
access handles are Dedicated-Worker-only). Real answer = P06: replicate shards to a
server peer (httpeers) that serves them — under the **same** `Lease`/epoch rules —
while no browser owns them.

## Harness hardening

An interrupted browser mutation run had left mutants in the working tree twice
(`browser/sharded/main.ts`, then `sw.ts`). Both harnesses now run in a throw-away copy
of the repo (`scripts/mutation-sandbox.mjs`) — the tree is never modified.

## Code
`src/lease/{lease,cas-lease,conditional-store}.ts`, `src/adapters/sqlite-lease.ts`,
`nodeSqliteOpener(dir, { exclusive })`, `src/router/cell-router.ts` (`watchOwner`,
`isAlive`, `ShardOwnerLostError`), `src/core/state.ts` + `object-host.ts` (reset on
failed `blockConcurrencyWhile`), `browser/sharded/*`; tests `test/p05c-lease.test.ts`,
`test/p05c-exclusive-cells.test.ts`, `test/p05-router.test.ts`, `test/p03-gates.test.ts`,
`browser/e2e/sharded.spec.ts`; probes `probes/sqlite-lock.probe.mjs`,
`browser/probes-e2e/port-lock-idle.probe.spec.ts`.
