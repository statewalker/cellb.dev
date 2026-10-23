# 22 — LTX: celld's page-level log format

**Goal.** Replace "changesets as a stand-in for LTX" (note 20) with the real thing: write and
read the transaction log in **LTX v3**, the format celld stores in its bucket, so that the
two systems could share cell storage.

## Codec (`src/ltx/`)

LTX v3 as celld writes it (`crates/ltx/reference/ltx-format.md` in denoland/celld): 100-byte
header, per-page LZ4 (legacy LZ4 frames as celld 0.6.2 writes them; size-prefixed LZ4 blocks
of ltx v0.5.2 also supported), page index of uvarints, 16-byte trailer, CRC-64/ISO checksums
with the top bit set, xxHash32 for the LZ4 frame checks. All in TypeScript (no WASM), so it
runs in Node and browsers.

Verified on **files written by the real celld** (`test/fixtures/celld-ltx/`, Counter example):
both decode with every checksum verified, their pages form a valid SQLite database, and
re-encoding (either page format) round-trips. celld 0.6.2 leaves the rolling database
checksums (pre/post-apply) at 0; only the file checksum is set.

## Page-level log (`filesApiLtxLog`)

- After each commit the runtime hands the durability port the database **image** (Node:
  the database file itself, page for page; SQLite WASM: `sqlite3_serialize` / the OPFS
  file). The pages that differ from the previous image become the transaction's LTX file;
  the first file of a generation is a snapshot (every page). The output gate holds replies
  until the file is stored: RPO 0 against the FilesApi.
- **celld's bucket layout**: `cells/<Class>:<id>/ltx/e<epoch>/0000/<min>-<max>.ltx`. Each
  owner epoch is a new generation starting with a snapshot at TXID 1; a restore reads the
  highest epoch. With celld-identical object ids (note 21) the same cell has the same keys.
- **Compaction** (`save()`): one snapshot file 1..N replaces the files it contains.
- Cost: an image per commit, O(database size) — fine for cell-sized databases; a VFS page
  hook in SQLite WASM would make it O(changed pages).

Tests (`test/p11b-ltx-log.test.ts`, node:sqlite file-backed and SQLite WASM): one LTX file per
transaction (snapshot first, then only changed pages), a fresh node restores from the files,
compaction keeps later commits.

## Interop with the real celld (`test/p11c-ltx-celld-interop.test.ts`, needs CELLD_BIN)

- **celld → webrun-cells: works.** The real celld writes a cell; its bucket objects (celld
  dev keeps them in `.celld/dev/objects.sqlite3`) are copied to a FilesApi at the same keys;
  `filesApiLtxLog.load()` rebuilds the database from celld's LTX files — the same tables and
  rows as celld's own replica (`_cf_KV` holds `n` V8-serialized, exactly as celld wrote it).
- **webrun-cells → celld: open.** LTX files written by webrun-cells under the next epoch, plus
  an updated `own.json`, are not used by celld 0.6.2: its restore chain comes from its own
  epoch bookkeeping (it picked e2 and reported "e2: ltx file corrupted"; deleting the local
  replica alone restores fine). Needs a closer reading of celld's `ltx_repl.rs` / ownership
  store (epoch chain, node bundles, log tier).

## What shared storage would still need

celld's **internal schema** differs from webrun-cells': `_cf_KV(scope, k, v)` with values in
**V8 serialization**, `_cf_ALARM`, `_cf_METADATA(scope, actor_name)`, `_cf_FACETS`, `_cf_WAKE`
and its triggers. A webrun-cells runtime opening a celld database fails today ("no such
column: value"). Adopting celld's schema and a JS V8-serialization codec (browsers have no
`v8.serialize`) would let the same cell move between celld and webrun-cells.
