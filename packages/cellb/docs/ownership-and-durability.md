# Ownership and durability

A cell is safe when two things hold: only one runtime writes it at a time, and every write it
acknowledged can be restored somewhere else. This page explains how cellb gets each, on each
deployment, and what you see when it does not. Terms are defined in [CONTEXT.md](../CONTEXT.md).

## Inside one cell: gates and the implicit transaction

These rules hold on every platform and with every storage.

- **Implicit transaction.** The first SQL statement of a handler turn opens a transaction; it commits
  when the turn ends. A hundred synchronous writes in one turn are one commit.
- **Input gate.** Events reach an object through a queue that a synchronous pump starts only while
  the gate is open. The first storage operation of a handler closes the gate before the next event
  can start, so read-modify-write over storage awaits is safe. The gate reopens on a macrotask, and
  waiters wake one at a time.
- **Output gate.** A reply leaves only after the commit it depends on is durable: the runtime waits
  for the storage's `committed()` promise. A read-only event is not delayed.
- **Reset.** If a commit fails to become durable, a constructor's `blockConcurrencyWhile()` rejects,
  or the cell lease is lost, the object is *broken*: queued and later callers get
  `BrokenObjectError` ("Durable Object reset because …"), and the next call builds a fresh instance.

The gates need no `AsyncLocalStorage`: each object owns its gate, and its storage holds it by
closure ([ADR 0004](adr/0004-gates-without-asynclocalstorage.md)).

## Ownership depends on the deployment

| Deployment | Unit owned | Mechanism | Fencing |
|---|---|---|---|
| One process, no shared storage | nothing to share | none needed | none |
| A browser origin, sharded | a shard (a fixed set of cells) | a Web Lock per shard, held by one shard worker | the lock itself: OPFS pools are exclusive per worker |
| A fleet bucket (celld nodes, cellb nodes, browsers) | a cell | celld's ownership records: `own.json` per cell, a node lease per node | the epoch in every log key, and self-fencing |

[ADR 0009](adr/0009-leases-chosen-by-deployment.md) records why there is no single lease for all
three. The `Lease` port (`tryAcquire(cellKey) → { epoch, lost, release }`) is per cell; its
implementation is `celldBucket(...).ownership`. Shard locks are taken by the browser wiring around
`CellRouter`, not through the port.

### A fleet bucket: celld's ownership protocol

`celldBucket(store, { node })` implements what celld writes in the bucket:

```
nodes/<node>.json                        node lease: expires_ms, address, load; renewed every ttl/3
cells/<Class>:<id>/own.json              ownership record: { node, epoch }
cells/<Class>:<id>/ltx/e<epoch>/0000/…   the cell's log, one generation per epoch
wake/entries/…, wake/retired/…           the wake index
wake/waker.json                          the waker role
r2/<bucket>/<key>                        R2 objects (owned by no cell)
```

- **Taking a cell.** The first activation creates `own.json` (`If-None-Match: *`). A later one
  raises the epoch with a compare-and-swap (`If-Match`), and only if the record names this node, no
  node, or a node whose node lease has expired. Losing the race returns no lease, and the call fails
  with `CellOwnedElsewhereError`, or goes to the owner when `peers` is configured.
- **The bucket wins over the local file.** Every time a node takes a cell, it replaces the cell's
  local database with the newest generation in the bucket, even when the local file is not empty
  (a directory given to `nodeSqliteOpener`, a browser's OPFS pool). That file may be from an earlier
  time this node owned the cell, older than what other owners wrote since, or hold commits that
  never became durable; continuing from it would log it as the new generation and lose the other
  owners' writes. A bucket that holds nothing for the cell starts it empty. The price is one
  download per acquisition, which the new generation's first commit pays again anyway as a
  snapshot. Without ownership the local file is the primary copy, and only an empty database is
  restored.
- **Releasing.** Closing the runtime writes `{ "node": "", epoch }` to each owned record, waits for
  those writes, then deletes the node lease and closes the store, so the next node takes the cells
  at once.
- **Self-fencing.** A node stops acknowledging writes once its node lease could have lapsed
  (`expires_ms` minus a margin), and a deadline timer breaks every owned cell when renewals stop
  arriving (a paused process, a frozen tab). celld waits for `expires_ms` before taking over, so the
  old owner has stopped first.
- **The node record is complete and unattractive.** It carries every field celld decodes, reports
  pressure and placement weight 0 (celld never pushes cells to it), and always has an address. A
  node that does not speak celld's peer protocol (a browser) gets `<node>.cellb.invalid:9`, so celld
  routes to it, fails and refuses, instead of treating the live owner as dead.
- **A lost record.** A missing `own.json` next to existing LTX means the record was lost. Both
  celld (from 0.6.3) and cellb refuse the cell for 10 s instead of restarting it empty; the repair is
  a released record `{"node": "", "epoch": <newest LTX epoch>}`.

### A browser origin: one shard per Web Lock

`shardOf(id, N)` places a cell in one of N shards for the lifetime of the deployment. A shard is one
Web Lock (`cellb:shard:<i>`), one OPFS SQLite pool, and one Dedicated Worker. Only the tab that holds
the lock starts that shard's worker; a second tab queues on the lock and takes over when the first
closes. Details are in [browser-host.md](browser-host.md).

## Durability: a log, a backup, or both

| Storage | What is written | RPO | Restore |
|---|---|---|---|
| none | local SQLite only | the local disk or OPFS | — |
| `filesApiLtxLog(files)` | one LTX file per commit, celld's keys, a fixed epoch | 0 | the newest epoch whose files chain from a snapshot |
| `celldBucket(store, …)` | the same LTX files, one generation per owner epoch | 0 | the same, then celld can read it too |
| `filesApiChangeLog(files)` | one SQLite changeset per commit, plus periodic snapshots | 0 | snapshot, then the segments after it |
| a `CellBackup` alone | a database image every `intervalMs` (30 s) | one interval | the last image, restored on first open |

- **The LTX log** is the format celld writes ([ADR 0001](adr/0001-celld-storage-format-is-native.md)).
  The first commit of a generation is a snapshot (every page, TXID 1); later commits carry only the
  changed pages. SQLite WASM reports changed pages through a hook on its database file; on Node the
  log diffs the image, or, with `nodeSqliteOpener(dir, { pageCapture: true })`, reads the pages from
  the WAL. A cell's commits are written strictly in order. Without a page hook the image is taken
  at commit time, not when the log gets to it: by then the next event may have opened a
  transaction, inside which SQLite cannot copy the database (`cannot VACUUM from within a
  transaction`, and the object would break).
- **The changeset log** records row changes through SQLite's session extension. It is cellb's own
  format and celld cannot read it; use it only where the LTX log does not fit.
- **Backups** save an image when a cell changed since the last successful save; `close()` takes a
  final one, `evictAll()` does not (it models a crash).

## Alarms are stored in the cell and published in the wake index

An alarm lives in the cell's `_cf_ALARM` row, as celld keeps it, so it survives restarts and moves
with the cell:

- `setAlarm()` resets the retry counters and gives the alarm a new random tag.
- While `alarm()` runs, the row stays and `getAlarm()` reads `null` unless the handler sets a new one.
- Success deletes the row if it still holds the fired alarm; a handler's own re-arm wins.
- Failure reschedules it at `now + 2 s << min(retry, 6)`; after 6 counted failures the alarm is
  dropped. Writes made by a failed attempt are kept.
- One `alarm()` runs at a time per object.

On a fleet bucket, every commit that changes the alarm publishes a wake entry once the commit is
durable, and retires older ones. Each runtime reads the wake index at start and every `wakePollMs`
(30 s). A node fires its own cells' alarms; the elected waker (`wake/waker.json`) fires those of
cells nobody live owns, and looks at a live owner's cell only after that owner's node lease would
have expired. A wake entry is only a hint: the stored alarm decides whether anything runs.

## What breaks

- **`Durable Object <Class>/<id> is owned by another node`** (`CellOwnedElsewhereError`). Another
  node's live ownership record holds the cell. Without `peers` the call fails; it succeeds once that
  node releases the cell or its node lease expires (10 s by default). celld's own message for the same
  case is "The Durable Object owner is currently unreachable".
- **`<cell>: this node's lease has lapsed; the write is refused (self-fencing)`**, then
  `BrokenObjectError`. The node could not renew its node lease in time: the bucket was unreachable or
  the process stalled. Restarting the node takes the cell again under a new epoch.
- **`ownership record lost: cells/<scope>/own.json is missing, but the bucket holds LTX …`**. A
  lifecycle rule or an operator removed `own.json`. Write the released record named in the message;
  neither celld nor cellb will guess the epoch.
- **Data written after the last backup is gone after a crash.** That is the backup's RPO, not
  corruption. Use a log for RPO 0.
- **Two browser tabs on one OPFS fleet bucket overwrite each other.** A FilesApi store checks
  conditions and then writes; that is atomic within one writer only. Let one tab or worker at a time
  use an OPFS bucket, or use S3.
- **A shard worker that died leaves requests failing with `ShardOwnerLostError`** ("the request may
  or may not have been applied"), about 30–50 ms after the tab closed. The router does not retry:
  requests are not idempotent in general.
- **A cell restored from celld's files is in WAL mode.** cellb's Node driver checkpoints before
  reading pages, and the WASM driver switches the file to rollback-journal mode on restore, because
  memdb and opfs-sahpool cannot open WAL files. A store that skips this logs stale pages.
