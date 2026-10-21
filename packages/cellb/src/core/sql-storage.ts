import type { SqlResult, SyncSqlDriver } from "../ports.js";

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
        `Expected exactly one result from SQL query, but got ${rest.length === 0 ? "no" : "multiple"} results.`,
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
export class SqlStorage {
  #driver: SyncSqlDriver;
  #onCommit: () => void;
  #inTxn = false;
  #holds = 0;
  #depth = 0;

  constructor(driver: SyncSqlDriver, onCommit: () => void) {
    this.#driver = driver;
    this.#onCommit = onCommit;
  }

  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
    if (FORBIDDEN_TXN.test(query))
      throw new Error(
        "To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of SQL BEGIN/COMMIT/SAVEPOINT.",
      );
    if (FORBIDDEN_INTERNAL.test(query))
      throw new Error("SQLITE_AUTH: access to _cf_ tables is not authorized");
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
    return this.#driver.exec(query, bindings);
  }

  transactionSync<T>(fn: () => T): T {
    this.#ensureTxn();
    const sp = `_cf_sp${++this.#depth}`;
    this.#driver.exec(`SAVEPOINT ${sp}`, []);
    try {
      const r = fn();
      this.#driver.exec(`RELEASE ${sp}`, []);
      return r;
    } catch (e) {
      this.#driver.exec(`ROLLBACK TO ${sp}`, []);
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
    this.#inTxn = false;
    this.#driver.exec("COMMIT", []);
    this.#onCommit();
  }

  rollback(): void {
    if (!this.#inTxn) return;
    this.#inTxn = false;
    this.#driver.exec("ROLLBACK", []);
  }

  #ensureTxn(): void {
    if (this.#inTxn) return;
    this.#driver.exec("BEGIN", []);
    this.#inTxn = true;
    queueMicrotask(() => this.commit());
  }
}
