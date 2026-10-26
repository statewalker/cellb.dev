# Plan: the cell open/close path — F0 stale local database, F8 awaited release, F5 idle databases

Branch `fix/stale-local-db`. Three items, one commit (or two) each, pushed when the bar is green.
All three change `packages/cellb/src/core/object-host.ts`; F5 also `src/core/runtime.ts`.

## F0 — a stale local database is served after re-acquiring a cell (data loss)

**Root cause.** `ObjectHost` restores from the bucket (`backup.load`, then `backup.replay`) only when
the local SQLite is empty (`object-host.ts` ~181). Under a cell lease the bucket is the cell's truth:
another owner may have written newer generations since this node last held the cell, and local
commits that never became durable may linger. A persistent opener (`nodeSqliteOpener(dir)`, the
OPFS pool in browsers) keeps that file, so the node serves it and logs it as the new generation.

**Design (simplest correct).** When the host holds a lease (its epoch is set: its own cell lease, or
its root's for a facet) and the storage can restore (`load` or `replay`), the local database is
rebuilt from the bucket on every open: `restore(image)` when the bucket has one, otherwise the local
schema is dropped, then the log is replayed. Without a lease (one node, local SQLite is primary,
e.g. `filesApiBackup` whose image lags the local file) the rule stays "restore only into an empty
database". Rejected: comparing the local generation/TXID with the log — the LTX log keeps no marker
in the database, and a marker cannot prove that local commits which failed to become durable are
absent; the rebuild costs one download per acquisition, which a new epoch already pays (its first
commit uploads a whole snapshot).

Browser: the OPFS pool is a persistent opener, so the same path applies; `restore(image)` goes
through `importDb`. A Chromium check is added only if an existing OPFS fleet-bucket e2e can take one
more step cheaply (otherwise noted in the report).

Tasks:
1. Test (red first) `test/p10e-stale-local-db.test.ts`: two runtimes ("A", "B"), one
   `celldBucket(memoryObjectStore())` per node on one store, `nodeSqliteOpener(dir)` with a directory
   per node. A counts 1, closes; B counts 2, closes; A (new runtime, same directory) counts → 3.
   Second case: a local database ahead of an empty bucket (a fresh store, same directory) starts empty.
2. Fix in `object-host.ts`: `#catchUp(rebuild)` replacing the inline empty-check block, `#wipe()`.
3. Docs: remove the caveat in `README.md` (What will surprise you), `docs/gaps.md` (Other gaps),
   `docs/ownership-and-durability.md` (What breaks); state the rule where restore is described.

## F8 — await the lease release on close (plan §8 F8)

`ObjectHost.close()` fires `void release()`, so `runtime.close()` closes the store while releases are
in flight and `own.json` stays held.

Tasks:
1. Test (red first) in `test/p10e-stale-local-db.test.ts`: a store whose operations take a macrotask
   and fail after `close()`; after `await runtime.close()` `own.json` reads `{ node: "", epoch: 1 }`,
   and a second node's `tryAcquire` succeeds at once.
2. `close(): Promise<void>` awaits the release; `runtime.close()` awaits all hosts before
   `storage.close()`. Other callers keep `void h.close()`.
3. Docs: remove the gap entry ("Await the lease release on close") and the What-breaks entry.

## F5 — idle databases (plan §8 F5)

A hibernated cell's SQLite handle is closed after a second, longer idle time and reopened by the next
event. The cell lease is kept (closing is not eviction: re-acquiring would start a new generation and
upload a whole snapshot on the next write).

Design: runtime option `closeDatabaseAfterMs` (off by default: an in-memory opener without a log
would lose the cell). The hibernation sweep, and `hibernateIdle()`, close the database of every
hibernated host idle that long, if nothing is left to back up. `ObjectHost` reaches SQLite through a
delegate whose target is swapped on reopen; the pump reopens under the closed input gate: open,
extensions, then `#catchUp(false)` — an empty reopened database (in memory) is restored from the
bucket, a persistent one is current because the lease was held throughout. A lost lease breaks the
host, and its replacement acquires and rebuilds (F0).

Tasks:
1. Test (red first) `test/p07k-idle-databases.test.ts`: an opener that counts open handles. With a
   directory: a call, `hibernateIdle(0)` → 0 handles; the next call sees the stored value → 1 handle.
   With an in-memory opener on a celld bucket: the value comes back after the close (catch-up on
   reopen).
2. Implement in `object-host.ts` (`closeDatabase()`, reopen in the pump) and `runtime.ts` (option,
   sweep).
3. Docs: remove the "Idle databases" planned item from `docs/gaps.md`; describe the option in the
   README; tick F5 and F8 in the restructure plan §8.

## Bar (each push)

`pnpm test` (celld env) vs 354/7/1 plus the new tests; Chromium `pnpm e2e` vs 181/14; `pnpm
mutate:check`; `pnpm -r typecheck`; `pnpm biome check .`.
