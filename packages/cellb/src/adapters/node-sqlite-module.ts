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

/** A zero-length view over a real buffer: node:sqlite binds it as an empty BLOB. */
const EMPTY_BLOB = new Uint8Array(1).subarray(0, 0);

/**
 * Bytes as node:sqlite binds them. Node 22 binds a view whose buffer has no backing store (the
 * buffer of `new ArrayBuffer(0)` or of a `Uint8Array` made from one) as NULL, not as an empty
 * BLOB: zero-length bytes are bound as EMPTY_BLOB instead. An ArrayBuffer becomes a view.
 */
export function nodeSqliteBytes(v: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (v.byteLength === 0) return EMPTY_BLOB;
  return v instanceof ArrayBuffer ? new Uint8Array(v) : (v as Uint8Array);
}
