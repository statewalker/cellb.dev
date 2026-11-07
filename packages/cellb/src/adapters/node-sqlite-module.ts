import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * `node:sqlite`, loaded without Node's "SQLite is an experimental feature" warning. cellb is
 * the one choosing the module, not its user, so the warning would only be noise on every start
 * (`loadProject`, `nodeSqliteOpener`). Only that warning is held back; any other passes.
 *
 * Loaded with `require`: bundlers (vite/vitest) strip the "node:" prefix of the experimental
 * builtin and then fail to resolve "sqlite".
 */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
    const text = typeof warning === "string" ? warning : warning?.message;
    const name = typeof warning === "string" ? type : (warning?.name ?? type);
    if (name === "ExperimentalWarning" && /\bSQLite\b/.test(String(text))) return;
    return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}
