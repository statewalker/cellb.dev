# 02 — P02 synchronous SQL and KV over SQL

**Objectives.** Reproduce the SQLite-backed DO storage API on a synchronous driver port:
`sql.exec()` cursor (`toArray/one/raw/columnNames/rowsRead/rowsWritten`), BLOBs as
`ArrayBuffer`, `databaseSize`, `transactionSync`, the sync KV (`ctx.storage.kv`) and the
async KV/`transaction()` API on top of `_cf_KV`.

**Conclusions.**
- The port is `SyncSqlDriver.exec(sql, params) → {columnNames, rows[][], rowsWritten}`.
  Arrays-of-arrays keep it cheap to marshal later over a MessagePort (browser Worker host).
- statewalker-db's async `Db` cannot back DO storage; the sync port sits *below* it.
  The browser libsql/SQLite WASM `oo1` API is sync, so the P04 adapter is thin — but it
  must live in a Worker to use opfs-sahpool persistence.
- **Implicit transaction**: first statement → `BEGIN`; `COMMIT` queued on a microtask.
  Verified with a second connection: two inserts invisible until the handler yields, then
  both visible. SQL `BEGIN/SAVEPOINT` and `_cf_*` access are rejected like on CF.
- `transactionSync` = nested SAVEPOINTs. Async `transaction()` spans awaits, so it keeps
  the input gate closed and *holds* auto-commit until the closure settles.
- KV ordering: SQLite BINARY collation on TEXT = UTF-8 byte order = CF key order.

**Lessons.** Values need an isomorphic serializer (no V8 `serialize` in browsers):
a tagged-JSON `ValueCodec` covers Date/Map/Set/bigint/buffers/undefined for now; swap
for webrun-msgpack behind the same port. Multi-statement scripts need a quote-aware
splitter because node:sqlite `prepare` only takes one statement.

**Open.** rowsRead is approximated by result rows. `deleteAll` drops user tables but
does not reset alarms (P07).

**Code.** `src/core/sql-storage.ts`, `src/core/storage.ts`, `src/core/codec.ts`,
`src/adapters/node-sqlite.ts`; tests `test/p02-sync-sql-kv.test.ts`.
