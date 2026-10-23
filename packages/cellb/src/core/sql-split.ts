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
