import type { CommitChanges, SqlResult, SyncSqlDriver } from "../ports.js";
import { LOG_SEQ_READ, LOG_SEQ_WRITE, LOG_TABLE } from "./celld-schema.js";

const FORBIDDEN_TXN = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const FORBIDDEN_INTERNAL = /\b_cf_\w*/i;

/** `ctx.storage.sql.exec()` cursor (iterable, one-shot like the CF one). */
export class SqlStorageCursor<T = Record<string, unknown>> implements Iterable<T> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  #rows: unknown[][];
  #pos = 0;
  constructor(r: SqlResult) {
    this.columnNames = r.columnNames;
    this.#rows = r.rows;
    this.rowsRead = r.rows.length;
    this.rowsWritten = r.rowsWritten;
  }
  next(): IteratorResult<T> {
    if (this.#pos >= this.#rows.length) return { done: true, value: undefined };
    return { done: false, value: this.#obj(this.#rows[this.#pos++]) };
  }
  [Symbol.iterator](): Iterator<T> {
    return this;
  }
  toArray(): T[] {
    return [...this];
  }
  one(): T {
    const rest = this.toArray();
    if (rest.length !== 1)
      throw new Error(
        `Expected exactly one result from SQL query, but got ${rest.length === 0 ? "no" : "multiple"} results`,
      );
    return rest[0];
  }
  *raw(): IterableIterator<unknown[]> {
    while (this.#pos < this.#rows.length) yield this.#rows[this.#pos++];
  }
  #obj(row: unknown[]): T {
    const o: Record<string, unknown> = {};
    for (const [i, c] of this.columnNames.entries()) o[c] = row[i];
    return o as T;
  }
}

/**
 * `ctx.storage.sql` with SQLite-backed-DO semantics: every write opens an
 * IMPLICIT transaction that commits on the next microtask (i.e. when the
 * handler yields). Sync writes therefore coalesce atomically, and the
 * output gate only has to await durability of the commit.
 */
const DDL = /^\s*(CREATE|ALTER|DROP)\b/i;
const WRITE_TARGET =
  /^\s*(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO\s+["`[]?([\w$]+)|^\s*UPDATE(?:\s+OR\s+\w+)?\s+["`[]?([\w$]+)|^\s*DELETE\s+FROM\s+["`[]?([\w$]+)/i;

export class SqlStorage {
  #driver: SyncSqlDriver;
  #onCommit: (changes?: CommitChanges) => void;
  #inTxn = false;
  #holds = 0;
  #depth = 0;
  // Transaction-log capture (only when the durability port asks for it).
  readonly #capture: boolean;
  #ddl: string[] = [];
  #statements: [string, unknown[]][] = [];
  readonly #noPk = new Map<string, boolean>();
  #changesAtBegin = 0;
  #schemaAtBegin = 0;
  #schemaVersion(): number {
    return Number(this.#driver.exec("PRAGMA schema_version", []).rows[0]?.[0] ?? 0);
  }
  #totalChanges(): number {
    return Number(this.#driver.exec("SELECT total_changes()", []).rows[0]?.[0] ?? 0);
  }

  constructor(
    driver: SyncSqlDriver,
    onCommit: (changes?: CommitChanges) => void,
    opts: { capture?: boolean } = {},
  ) {
    this.#driver = driver;
    this.#onCommit = onCommit;
    this.#capture = !!opts.capture;
    if (this.#capture && !driver.captureStart)
      throw new Error("This SyncSqlDriver cannot capture changes: no transaction-log durability");
  }

  /** Records what the changeset cannot carry: schema changes, and writes to PK-less tables. */
  #record(query: string, bindings: unknown[]): void {
    if (!this.#capture) return;
    if (DDL.test(query)) {
      this.#ddl.push(query);
      this.#noPk.clear();
      return;
    }
    if (this.#driver.captureCoversRowidTables !== false) return;
    const m = WRITE_TARGET.exec(query);
    const table = m?.[1] ?? m?.[2] ?? m?.[3];
    if (table && this.#tableHasNoPk(table)) this.#statements.push([query, bindings]);
  }

  #tableHasNoPk(table: string): boolean {
    let v = this.#noPk.get(table);
    if (v === undefined) {
      const info = this.#driver.exec(`SELECT count(*) FROM pragma_table_info(?) WHERE pk > 0`, [
        table,
      ]);
      v = Number(info.rows[0]?.[0] ?? 0) === 0;
      this.#noPk.set(table, v);
    }
    return v;
  }

  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
    // Messages as celld words them (storage-details project): its authorizer refuses
    // transaction statements and reads of internal tables at prepare time.
    if (FORBIDDEN_TXN.test(query)) throw new Error("SQL error: prepare SQL cursor: not authorized");
    const internal = FORBIDDEN_INTERNAL.exec(query);
    if (internal) {
      const table = internal[0];
      // celld names the first column of its own internal schema (_cf_KV starts with `scope`).
      const column = table.toLowerCase() === "_cf_kv" ? "scope" : "key";
      throw new Error(`SQL error: prepare SQL cursor: access to ${table}.${column} is prohibited`);
    }
    if (bindings.length && countParameters(query) !== bindings.length)
      throw new Error("SQL error: Wrong number of parameter bindings for SQL query.");
    return new SqlStorageCursor<T>(this.internalExec(query, bindings));
  }

  /**
   * workerd's `sql.prepare(query)`: a reusable statement, called with bindings.
   * Not in Cloudflare's public docs, but used by Miniflare's simulator objects.
   */
  prepare<T = Record<string, unknown>>(
    query: string,
  ): (...bindings: unknown[]) => SqlStorageCursor<T> {
    return (...bindings) => this.exec<T>(query, ...bindings);
  }

  get databaseSize(): number {
    return this.#driver.databaseSize();
  }

  /** Unguarded path for the runtime's own tables (_cf_KV, _cf_METADATA). */
  internalExec(query: string, bindings: unknown[] = []): SqlResult {
    this.#ensureTxn();
    const r = this.#driver.exec(query, bindings);
    this.#record(query, bindings);
    return r;
  }

  transactionSync<T>(fn: () => T): T {
    this.#ensureTxn();
    const sp = `_cf_sp${++this.#depth}`;
    this.#driver.exec(`SAVEPOINT ${sp}`, []);
    const marks = [this.#ddl.length, this.#statements.length] as const;
    try {
      const r = fn();
      this.#driver.exec(`RELEASE ${sp}`, []);
      return r;
    } catch (e) {
      this.#driver.exec(`ROLLBACK TO ${sp}`, []);
      for (const f of this.rolledBack) f();
      this.#ddl.length = marks[0];
      this.#statements.length = marks[1];
      this.#driver.exec(`RELEASE ${sp}`, []);
      throw e;
    } finally {
      this.#depth--;
    }
  }

  /** Suspends auto-commit (used by the async `transaction()` which spans awaits). */
  hold(): () => void {
    this.#holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#holds === 0) queueMicrotask(() => this.commit());
    };
  }

  /** True while an async transaction() holds auto-commit (no consistent snapshot possible). */
  get held(): boolean {
    return this.#holds > 0;
  }

  /** Commits the implicit transaction now (no-op if none, or if held). */
  commit(): void {
    if (!this.#inTxn || this.#holds > 0) return;
    let changes: CommitChanges | undefined;
    // Read-only transactions produce no log segment ("IF NOT EXISTS" DDL that changed
    // nothing included: the schema version tells).
    if (this.#capture && this.#ddl.length && this.#schemaVersion() === this.#schemaAtBegin)
      this.#ddl = [];
    if (this.#capture && (this.#ddl.length || this.#totalChanges() !== this.#changesAtBegin)) {
      // The log sequence number lives in the database, inside the same transaction.
      this.#driver.exec(LOG_TABLE, []);
      const row = this.#driver.exec(LOG_SEQ_READ, []).rows[0];
      const logSeq = Number(row?.[0] ?? 0) + 1;
      this.#driver.exec(LOG_SEQ_WRITE, [logSeq]);
      changes = {
        logSeq,
        ddl: this.#ddl,
        changeset: new Uint8Array(),
        statements: this.#statements,
      };
    }
    this.#inTxn = false;
    this.#driver.exec("COMMIT", []);
    if (this.#capture) {
      const changeset = this.#driver.captureTake!();
      if (changes) changes.changeset = changeset;
      this.#ddl = [];
      this.#statements = [];
    }
    this.#onCommit(changes);
  }

  /** Called after a rollback (lazily created internal tables may be gone). */
  readonly rolledBack = new Set<() => void>();

  rollback(): void {
    if (!this.#inTxn) return;
    this.#inTxn = false;
    this.#driver.exec("ROLLBACK", []);
    this.#driver.discardDirtyPages?.(); // pages a rolled-back transaction spilled are not a commit
    for (const f of this.rolledBack) f();
    if (this.#capture) {
      this.#driver.captureDiscard?.();
      this.#ddl = [];
      this.#statements = [];
    }
  }

  #ensureTxn(): void {
    if (this.#inTxn) return;
    this.#driver.exec("BEGIN", []);
    if (this.#capture) {
      this.#driver.captureStart!();
      this.#changesAtBegin = this.#totalChanges();
      this.#schemaAtBegin = this.#schemaVersion();
    }
    this.#inTxn = true;
    queueMicrotask(() => this.commit());
  }
}

/** Parameters a statement expects: anonymous `?` count, highest `?NNN`, distinct named ones. */
export function countParameters(sql: string): number {
  let anon = 0;
  let maxNumbered = 0;
  const named = new Set<string>();
  const re = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d*)|([:@$][A-Za-z_]\w*)/g;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    if (m[1] !== undefined) {
      if (m[1] === "") anon++;
      else maxNumbered = Math.max(maxNumbered, Number(m[1]));
    } else if (m[2]) named.add(m[2]);
  }
  const positional = maxNumbered ? Math.max(maxNumbered, anon) : anon;
  return positional + named.size;
}
