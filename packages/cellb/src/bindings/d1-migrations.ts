/**
 * D1 migrations as celld (and wrangler) apply them: files `NNNN_description.sql` (extension
 * ASCII case-insensitive) in `migrations_dir` (default `migrations/`), applied in the order of
 * their numeric prefixes, each recorded in `migrations_table` (default `d1_migrations`, the
 * table and columns `wrangler d1 migrations` uses). celld runs this from its CLI against a
 * fleet; webrun-cells exposes it as a function on the D1 binding, for any host.
 */
export interface D1Like {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): {
    bind(...v: unknown[]): { run(): Promise<unknown> };
    all<T>(): Promise<{ results: T[] }>;
  };
}

const FILE = /^(\d+)_.+\.sql$/i;

export function sortMigrations(files: [string, string][]): [string, string][] {
  return files
    .filter(([name]) => FILE.test(name))
    .sort(([a], [b]) => Number(FILE.exec(a)![1]) - Number(FILE.exec(b)![1]) || a.localeCompare(b));
}

export async function listAppliedMigrations(
  db: D1Like,
  table = "d1_migrations",
): Promise<string[]> {
  await ensureTable(db, table);
  const { results } = await db
    .prepare(`SELECT name FROM ${table} ORDER BY id`)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Applies the migrations not yet recorded; returns the names applied now. */
export async function applyD1Migrations(
  db: D1Like,
  files: [string, string][],
  table = "d1_migrations",
): Promise<string[]> {
  const done = new Set(await listAppliedMigrations(db, table));
  const applied: string[] = [];
  for (const [name, sql] of sortMigrations(files)) {
    if (done.has(name)) continue;
    await db.exec(sql);
    await db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name).run();
    applied.push(name);
  }
  return applied;
}

async function ensureTable(db: D1Like, table: string): Promise<void> {
  if (!/^\w+$/.test(table)) throw new Error(`invalid migrations_table: ${table}`);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
  );
}
