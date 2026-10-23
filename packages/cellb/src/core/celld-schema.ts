/**
 * celld's internal tables, statement for statement (read from a database celld 0.6.2
 * wrote): Durable Object KV in `_cf_KV(scope, k, v)` with V8-serialized values, the alarm in
 * `_cf_ALARM`, the object's name in `_cf_METADATA(scope, actor_name)`, facets and wake-up
 * bookkeeping. webrun-cells uses the same tables, so a cell's database (and its LTX log)
 * reads the same in both. `scope` is celld's cell name, `<Class>:<id hex>`.
 */
export const CELLD_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS _cf_KV (scope TEXT, k TEXT, v TEXT, PRIMARY KEY(scope,k))",
  "CREATE TABLE IF NOT EXISTS _cf_ALARM (scope TEXT PRIMARY KEY, at_ms INTEGER, retry INTEGER DEFAULT 0, counted_retry INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS _cf_METADATA (scope TEXT PRIMARY KEY, actor_name TEXT)",
  "CREATE TABLE IF NOT EXISTS _cf_FACETS (scope TEXT NOT NULL, path TEXT NOT NULL, image BLOB NOT NULL, PRIMARY KEY(scope,path)) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS _cf_WAKE (
           scope TEXT PRIMARY KEY, epoch TEXT NOT NULL CHECK(length(epoch)=16),
           sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0),
           at_ms INTEGER
         )`,
  `CREATE TRIGGER IF NOT EXISTS _cf_WAKE_insert AFTER INSERT ON _cf_ALARM BEGIN
               UPDATE _cf_WAKE SET sequence=sequence+1,at_ms=NEW.at_ms WHERE scope=NEW.scope;
             END`,
  `CREATE TRIGGER IF NOT EXISTS _cf_WAKE_update AFTER UPDATE OF at_ms,generation ON _cf_ALARM BEGIN
               UPDATE _cf_WAKE SET sequence=sequence+1,at_ms=NEW.at_ms WHERE scope=NEW.scope;
             END`,
  `CREATE TRIGGER IF NOT EXISTS _cf_WAKE_delete AFTER DELETE ON _cf_ALARM BEGIN
               UPDATE _cf_WAKE SET sequence=sequence+1,at_ms=NULL WHERE scope=OLD.scope;
             END`,
];

/** webrun-cells' own bookkeeping (not in celld): the transaction-log sequence number. */
export const LOG_TABLE =
  "CREATE TABLE IF NOT EXISTS _cf_LOG (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)";
export const LOG_SEQ_READ = "SELECT seq FROM _cf_LOG WHERE id = 1";
export const LOG_SEQ_WRITE = "INSERT OR REPLACE INTO _cf_LOG (id, seq) VALUES (1, ?)";

/** celld's cell name for a webrun-cells cell key ("Class/idhex" → "Class:idhex"). */
export const scopeOf = (cellKey: string) => cellKey.replace("/", ":");
