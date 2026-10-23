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

## Remaining differences

- Facet databases (`_cf_FACETS`, stored inside the parent's database on celld) are not
  carried yet; webrun-cells keeps facets in separate cell databases.
- celld's `_cf_WAKE` rows (fleet wake-up bookkeeping) are created by celld on activation;
  webrun-cells creates the table and triggers but not the rows.
