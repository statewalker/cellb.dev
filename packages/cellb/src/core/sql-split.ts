const TRIGGER = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;

/** Splits a param-less SQL script on top-level `;` (respects quotes, comments, triggers). */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
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
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [sql];
}

/**
 * The complete statements at the start of `sql` (each ended by a top-level `;`, a trigger body
 * as one), and what follows the last of them: the `remainder` of workerd's `sql.ingest()`, kept
 * as it is (whitespace, a comment, an unfinished statement or string).
 */
export function takeCompleteStatements(sql: string): { statements: string[]; remainder: string } {
  const statements: string[] = [];
  let start = 0; // where the current statement begins
  let code = ""; // the current statement without comments, to recognize a trigger
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = sql.indexOf(c === "[" ? "]" : c, i + 1);
      if (end < 0) break; // an unfinished string: incomplete
      code += sql.slice(i, end + 1);
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      if (end < 0) break;
      i = end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (c === ";") {
      if (TRIGGER.test(code) && !/\bEND\s*$/i.test(code)) {
        code += c;
        continue;
      }
      if (code.trim()) statements.push(sql.slice(start, i + 1).trim());
      start = i + 1;
      code = "";
    } else code += c;
  }
  return { statements, remainder: sql.slice(start) };
}

const COMMENTS = /--[^\n]*(\n|$)|\/\*[\s\S]*?(\*\/|$)/g;

/** Whether `sql` is comments and nothing else (an empty `sql` is not). */
export function onlyComments(sql: string): boolean {
  return sql.replace(COMMENTS, " ").trim() === "" && sql.trim() !== "";
}

/** Whether `sql` holds a statement: anything but whitespace, comments and `;`. */
export function hasStatement(sql: string): boolean {
  return sql.replace(COMMENTS, " ").replace(/;/g, " ").trim() !== "";
}
