---
status: accepted
---

# Ownership is chosen by the deployment, not by one universal lease

Who may write a cell is decided by what the deployment can guarantee:

- **In a browser origin**, a shard worker holds the shard's Web Lock. The browser grants a lock to
  one holder at a time and frees it when the holder dies, and the OPFS pool is exclusive anyway.
- **On a fleet bucket**, a node owns a cell through celld's ownership protocol: an `own.json`
  record per cell taken by compare-and-swap with a rising epoch, and a node lease per node. This is
  what celld nodes read, so cellb nodes and celld nodes can share cells.

The `Lease` port is per cell, and its implementation is `celldBucket(...).ownership`. Shard locks
are taken by the browser wiring around `CellRouter`, not through the port.

## Considered options

- **A generic compare-and-swap lease over a conditional store**, the same for every deployment.
  Removed: it duplicated the object store's own conditional `put`, was used only by tests, and celld
  could not read its records.
- **A heartbeat registry of files**, as Miniflare 4's dev registry. Removed: it elects without
  fencing, so a paused process can still write.
- **A SQLite file lock** on one host. Removed with the others: it works only on a local filesystem
  of one machine, which no supported deployment needs.

## Consequences

- "Owner" means two things by deployment: the holder of a shard lock inside an origin, the node named
  in the ownership record in a fleet. The two are never combined today.
- A fleet bucket in a browser's OPFS uses the bucket protocol over a store whose conditional writes
  are atomic within one writer only: one tab at a time.
