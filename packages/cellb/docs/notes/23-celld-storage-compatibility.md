# 23 — Storage compatibility with celld, and the SQLite WASM page hook

**Goal.** Logs and dumps written by webrun-cells are readable by celld, and the other way
around: the same Durable Object can move between the two through one bucket.

## What makes a cell's storage identical

| Layer | celld 0.6.2 | webrun-cells now |
|---|---|---|
| Object ids | HMAC-SHA-256 over the name, script/class namespace keys (note 21) | identical bytes |
| Bucket keys | `cells/<Class>:<id>/ltx/e<epoch>/0000/<min>-<max>.ltx`, `own.json` | same keys (`filesApiLtxLog`, `celldBucket`) |
| Log files | LTX v3, legacy LZ4 frames, **flags = NO_CHECKSUM**, rolling checksums 0 | same; header flags and WAL fields preserved |
| Generations | one per owner epoch, starting with a snapshot at TXID 1; restore reads the newest | same |
| Internal tables | `_cf_KV(scope, k, v)`, `_cf_ALARM`, `_cf_METADATA(scope, actor_name)`, `_cf_FACETS`, `_cf_WAKE` + triggers | same DDL (`celld-schema.ts`); webrun-cells' log sequence lives in its own `_cf_LOG` |
| Stored values | V8 serialization (version 15) | `src/v8/serialize.ts`: byte-identical to Node's V8 on a 19-kind corpus; native typed-array encoding |

## The bug that blocked celld from reading our files

Our encoder always wrote header flags 0 ("checksums on") while leaving the rolling
checksums at 0. celld's validator then requires a real post-apply checksum on snapshots and
a pre-apply checksum on incremental files, and reported "ltx file corrupted". celld's own
files carry `NO_CHECKSUM`; the encoder now writes it whenever both checksums are 0, and
keeps the WAL offset/size/salt fields — the header of a re-encoded celld file is now
byte-identical.

## Verified against the real celld (`test/p11c-*`, needs CELLD_BIN)

1. celld's LTX files restore byte-identical pages in webrun-cells.
2. celld restores a cell from LTX files webrun-cells wrote under the next epoch.
3. **The same Counter continues across runtimes**: celld 1→3, webrun-cells (from celld's files,
   same ids, same tables, V8 values) → 4, celld (from webrun-cells' files) → 5.
4. **Stored values both ways** (`kv-values` project: numbers, strings, bigint, Date, RegExp,
   Map, Set, sparse arrays, ArrayBuffer, typed arrays, DataView, nested objects): what celld
   wrote reads identically in webrun-cells, and the reverse.
5. Moving an object through one bucket with ownership hand-over (`celldBucket` over celld
   dev's `objects.sqlite3`, epoch CAS on `own.json`, node leases).

## The page hook in SQLite WASM (`src/adapters/wasm-page-hook.ts`)

Before: an LTX file per commit needed the whole database image (O(database size)). Now the
WASM driver hooks its main database file: `SQLITE_FCNTL_FILE_POINTER` gives the
`sqlite3_file`; a copy of its `sqlite3_io_methods` gets a JS `xWrite`
(`wasm.installFunction("i(ppij)", …)`) that records (offset → page bytes) and calls the
original (`wasm.functionEntry`); the file's `pMethods` points to the copy. No VFS is
registered, so it works over any VFS — **opfs-sahpool** in browsers, memdb, unix.

- After a commit, the recorded pages are exactly the transaction's changed pages: the LTX
  writers (`filesApiLtxLog`, `celldBucket`) use them directly; the image is read only for a
  generation's first snapshot (it is passed as a thunk).
- A rolled-back transaction's spilled pages are discarded; after `restore()` the hook is
  installed on the new file.
- In-memory cells use the memdb VFS (`file:/cells-mem-N?vfs=memdb`) instead of `:memory:`,
  which has no file to hook.
- node:sqlite has no such hook; there the LTX log reads the database file (raw pages) and
  diffs it against the previous image.

Tests: `test/p11d-wasm-page-hook.test.ts` (exact pages equal to the image, rollback
discard, re-hook after restore); `browser/e2e/ltx.spec.ts` (Chromium, OPFS sahpool: a
2000-row database, each later commit writes only a few pages, an empty pool restores the
cell from the LTX files).

## Facets

celld 0.6.2 gives each facet a database and an LTX stream of its own (`_cf_FACETS` images are
only a legacy import path): `cells/<root>/facets/<SHA-256(name)[0..16] hex>/ltx/e<epoch>/…`,
nested facets append further segments, the facet uses its root's epoch, and on open the
facet's rows move to the current run's scope. webrun-cells now does the same (facet cell
keys, no facet lease — the root's epoch — and the rescope on open). Test: a Durable Object
whose state lives in a facet goes celld (2) → webrun-cells (3) → celld (4), parent and facet
streams both restored on each side.

## Facets of isolated loaded code

A facet whose class comes from a Worker Loader runs inside its isolate (note 21). Its
database is now logged **through the host**: the isolate's runtime gets a durability port that
forwards each commit (changed pages; the image is fetched from the isolate only when a
generation snapshot needs it) and a backup port whose `load()` asks the host — keyed by the
facet's celld key under the root and written under the root's epoch (`attach`). Objects of an
isolate's runtime are facets: their rows are rescoped on open. Tests: a fresh node continues
an isolated facet from the host's LTX files (`p11e`); **celld's own `facets` example** (a
Worker-Loader class as facet) goes celld (0, 1) → webrun-cells (2) → celld (3).

## Two bugs found by these tests

- **WAL images.** A database restored from celld's files is in WAL mode. node:sqlite then
  commits into the `-wal` file, so reading the main file as the page image returned the state
  before the commit: the LTX file carried stale pages. The Node driver now checkpoints before
  reading. The WASM VFSes (memdb, opfs-sahpool) cannot open WAL files at all: the WASM driver
  switches the header to rollback-journal mode on restore (same pages; celld turns WAL back on
  when it opens the database). The Counter round trip runs on both drivers.

## One bucket, celld's ownership protocol, no manual step (`test/p11f-*`)

Earlier interop tests moved files and edited `own.json` by hand. The real path is
`celldBucket` on the shared object store: ownership by compare-and-swap on `own.json`
epochs, node leases in `nodes/`, LTX streams per cell and per facet. Through celld dev's own
`objects.sqlite3`, each of these goes celld → webrun-cells → celld with the state continuing,
on node:sqlite and on SQLite WASM: the Counter, a facet's state, celld's facets example (a
Worker-Loader facet), stored values of every kind.

## Alarms cross through celld's wake index

celld finds alarms of inactive cells through a bucket-level index, not by opening databases:
`wake/entries/<UTC minute due>/<cell>/<epoch16>-<seq16>` (`{cell, due_ms, format: 2,
identity}`), `wake/retired/<cell>.json` voiding older (or cancelled) identities, and
`wake/format.json`. The identity comes from the cell's `_cf_WAKE` row: the writer epoch, and
a sequence the `_cf_ALARM` triggers bump on every change (`storage/wake_record.rs`).

webrun-cells now (a) initializes the `_cf_WAKE` row with its epoch when it opens a cell, as
celld does; (b) after a commit that changed the alarm, publishes the entry (or the
retirement) once the commit is durable; (c) at start, reads the index and arms those alarms
(an entry is a hint: `alarm()` runs only if the stored alarm is still due). Tests: an alarm
armed in webrun-cells fires in celld, one armed in celld fires in webrun-cells; without our
wake entry celld does not fire it (checked).

## A real celld fleet node on S3 (`test/p11g-celld-rustfs.test.ts`)

Beyond celld dev's local store: a celld **fleet node** (`celld --bucket s3://cells/<prefix>
--endpoint …`) and webrun-cells share one S3 bucket served by a local RustFS. The Counter
goes celld → webrun-cells → celld, and alarms cross through the wake index in both
directions. Needs CELLD_BIN and a RustFS (RUSTFS_ENDPOINT, default `http://127.0.0.1:9100`).
Fixes it required: an S3 prefix is a directory (`s3://BUCKET/PREFIX` → keys under
`PREFIX/`, as celld uses it); the wake index is re-read periodically (`wakePollMs`, default
30 s) so alarms of cells whose owner went away are picked up, as celld's waker does; a wake is
only a hint — the stored alarm decides (fired or deleted elsewhere: nothing; moved later: wait),
and a cell owned by another node is left to its owner.

The first run of the Counter case after the interrupted session failed once (celld continued
from its own state); five later runs passed. Kept with a diagnostic message showing celld's
restore path if it recurs.

## Remaining differences

- Wake-entry cleanup: celld deletes entries below a proved retirement frontier; webrun-cells
  writes entries and retirements but leaves cleanup to celld.
- Browser project hosts do not configure a host log yet, so isolated facets there keep
  their database in the isolate's OPFS pool only.
