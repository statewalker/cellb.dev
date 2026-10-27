/** A trigger's creation, also under EXPLAIN (`sql.ingest()` prepares each statement so). */
const TRIGGER = /^\s*(?:EXPLAIN\s+)?CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;

/**
 * The statements of a SQL script ended by a top-level `;` (quotes, comments and trigger bodies
 * respected), each without its comments, with the offset just past its `;`; then the text after
 * the last one, with `end` undefined.
 */
function* scanSql(sql: string): Generator<{ text: string; end?: number }> {
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const end = sql.indexOf(c, i + 1);
      const j = end < 0 ? sql.length : end;
      cur += sql.slice(i, j + 1);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === ";") {
      // A trigger body (CREATE TRIGGER … BEGIN …; …; END) is one statement.
      if (TRIGGER.test(cur) && !/\bEND\s*$/i.test(cur)) {
        cur += c;
        continue;
      }
      yield { text: cur, end: i + 1 };
      cur = "";
    } else cur += c;
  }
  yield { text: cur };
}

/** Splits a param-less SQL script on top-level `;` (respects quotes, comments, triggers). */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  for (const { text } of scanSql(sql)) if (text.trim()) out.push(text.trim());
  return out.length ? out : [sql];
}

/**
 * The complete statements at the start of a chunk of SQL text (each ended by a top-level `;`,
 * as `sqlite3_complete` sees it) and the text after the last of them, untouched.
 */
export function completeSqlStatements(sql: string): { statements: string[]; remainder: string } {
  const statements: string[] = [];
  let rest = 0;
  for (const { text, end } of scanSql(sql)) {
    if (end === undefined) break;
    if (text.trim()) statements.push(text.trim());
    rest = end;
  }
  return { statements, remainder: sql.slice(rest) };
}

const COMMENTS = /--[^\n]*(\n|$)|\/\*[\s\S]*?(\*\/|$)/g;

/**
 * Whether `sql` holds no statement to run (workerd and celld: "SQL code did not contain a
 * statement"): nothing but whitespace, comments and `;`, or a last statement of comments alone.
 */
export function lacksStatement(sql: string): boolean {
  if (sql.replace(COMMENTS, " ").replace(/;/g, " ").trim() === "") return true;
  const { remainder } = completeSqlStatements(sql);
  return remainder.trim() !== "" && remainder.replace(COMMENTS, " ").trim() === "";
}
