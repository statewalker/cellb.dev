# 20 — Transaction log, ownership, hibernation, and the remaining runtime APIs

## Transaction log on a FilesApi (P10)

celld captures each committed SQLite write as an **LTX** segment (page frames) and
acknowledges a write only once it is durable outside the node. LTX needs page-level capture
— a VFS hook. node:sqlite has none; SQLite WASM could get one by wrapping its OPFS VFS.
webrun-cells uses the **SQLite session extension** instead: the *row changes* of each
transaction as a changeset. Available in both drivers (node:sqlite `createSession` /
`applyChangeset`; WASM `sqlite3session_*` / `sqlite3changeset_apply`).

| | |
|---|---|
| Capture | `SqlStorage` starts a session at BEGIN; at COMMIT it takes the changeset, the schema statements of the transaction, and — on node:sqlite only, which lacks the ROWID session option — the write statements on tables without a PRIMARY KEY. Read-only transactions and no-op `IF NOT EXISTS` DDL (schema version unchanged) write nothing |
| Sequence | `log_seq` in `_cf_METADATA`, written in the same transaction; a snapshot therefore knows which segments it contains |
| Storage | `filesApiChangeLog(files)`: `{cell}/log/{epoch}-{logSeq}.seg` (magic, JSON header, changeset bytes); `committed()` resolves when the segment is written and the **output gate** holds the reply until then — RPO 0 against the FilesApi (OPFS, S3, disk) |
| Snapshots | the existing backup path; after a successful snapshot the segments ≤ its `logSeq` are deleted |
| Restore | snapshot image, then the segments after its `logSeq`, in order, gap-checked |
| Fencing | a segment of epoch *e* is void from the first `logSeq` that any epoch > *e* wrote: a stale owner's late writes never replay (celld puts the epoch in its log keys the same way) |

Tests: `test/p10-change-log.test.ts` (both drivers: rebuild from the log alone, snapshot + tail
with compaction, RPO 0 through the output gate, stale-owner fencing) and
`browser/e2e/changelog.spec.ts` (a worker with an EMPTY OPFS SQLite pool rebuilds the cell
from the OPFS log). Sanity mutants (no replay, no fencing) are caught.

**LTX proper** remains possible for the WASM driver: a VFS wrapper recording the pages of each
transaction would produce real LTX files (and be byte-compatible with celld/LiteFS tooling).
The changeset design keeps the same contract (segments, snapshot + replay, fencing), so it can
be swapped behind `CellDurability`/`CellBackup`.

## Ownership (P10b)

`createCellRuntime({ ownership: lease })`: each object takes **its cell's lease** before it
restores (any `Lease`, e.g. `CasLease` over conditional writes — S3 If-Match). No lease →
`CellOwnedElsewhereError` (route the request to the owner, or retry later). The lease epoch
stamps the cell's log segments; losing the lease (renewal impossible past ttl − skew) breaks
the host, so it stops serving. `test/p10b-ownership.test.ts`: two nodes, one bucket; the owner
is partitioned, loses its lease, the other node takes over, restores from the log and continues;
the log holds both epochs. Missing for a fleet: request routing to the owner (celld: signed
peer HTTP), and hard write-time fencing (conditional segment writes) on stores that have it.

## Hibernation (P07i)

`createCellRuntime({ hibernateAfterMs })` (or `runtime.hibernateIdle(ms)`): an idle object —
no event in flight or queued, no open async transaction, no standard WebSocket — drops its
instance; the next event (WebSocket message or close, alarm, request) constructs the class
again. Storage, alarms, hibernatable sockets (`ctx.acceptWebSocket`) and their attachments
survive; a socket accepted with `accept()` pins the object until it closes, as on Cloudflare.
`test/p07i-hibernation.test.ts`. Not yet: unloading the *database* of sleeping cells, and a
waker for cells whose owner died (needs routing).

## Runtime APIs and bindings added (all compared with celld 0.6.2)

| API | Project | Result |
|---|---|---|
| Cache API (always-miss, like celld) | runtime-api | match |
| Service bindings to the script's own entrypoints (fetch + RPC) | runtime-api | match |
| KV bulk `get([...])` | runtime-api | match |
| Worker Loader `load()`, `dispose()`, `globalOutbound` | runtime-api | match |
| WebSocket attachments | runtime-api | match |
| R2 `onlyIf` (object or Headers) on get/put; multipart uploads | r2-advanced | match |
| Workflows `instance.delete()`, `deleteBatch()` | workflow-api | match |
| HTMLRewriter (sync handlers) | html-rewriter | match |
| HTMLRewriter **async** handlers | html-rewriter-async | **known gap** (expected mismatch) |

HTMLRewriter runs on lol-html WASM vendored from the `htmlrewriter` package
(`scripts/vendor-htmlrewriter.mjs`) with two fixes — its asyncify glue never received the WASM
exports, and its stream loop did not await `write()`/`end()` — and lazy WASM loading (fs on
Node, fetch in browsers). Async element handlers still panic inside the WASM ("unreachable"):
next candidate is Miniflare's `html-rewriter-wasm`, whose async support is proven.

## Still missing

`nodejs_compat` (`node:*` modules), D1 migrations, Queues `max_concurrency`, cron catch-up
after downtime, static-assets `force/drop-trailing-slash`, `.assetsignore`, PITR, Python
Workers, isolation of loaded Workers, request routing between nodes.
