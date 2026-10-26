---
status: accepted
---

# Fixed shards in a browser origin

Inside one browser origin, cells are partitioned into a fixed number N of shards: `shardOf(id, N)`.
A shard is one Web Lock, one OPFS SQLite pool and one Dedicated Worker; the tab holding the lock
runs the worker, and a ServiceWorker router forwards requests to it.

Two browser facts force partitioning: an opfs-sahpool pool can be open in one worker only
(`NoModificationAllowedError` for the second), and a ServiceWorker cannot spawn workers. So storage
must be split, each part must have one worker, and the page must own that worker.

## Considered options

- **One worker for all cells.** Simplest, but one tab then holds every cell and nothing spreads the
  load across workers.
- **One worker per cell.** Each SQLite database takes pool slots and a worker; thousands of cells
  would mean thousands of workers.
- **Placement through a directory** (cells assigned on demand). Needs a shared, consistent directory
  in the origin and a migration step on every move; fixed hashing needs neither.

## Consequences

- Changing N moves cells between pools: it needs a migration.
- Shards exist only inside a browser origin. On a fleet bucket ownership is per cell, and a browser
  project runtime runs in one worker without shards.
