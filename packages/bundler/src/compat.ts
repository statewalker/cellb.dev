/**
 * Host compatibility, added to a Worker at build time so one build runs on every host.
 *
 * The bundle's entry becomes a small module that re-exports the project's entry and wraps its
 * default handler object: before each handler call it patches the D1 bindings it is given (once
 * per binding object, in place, so `env` from `cloudflare:workers` sees the same patch).
 *
 * - celld 0.6.3 lists its own replication table (`_litestream_lock`) in `sqlite_master` but
 *   refuses to read it ("not authorized"). Kysely's SQLite introspector reads the columns of
 *   every table `sqlite_master` lists, so EmDash's migrations fail there. A table-valued pragma
 *   on such an internal table (`_litestream_*`, `_cf_*`) answers no rows instead.
 *
 * On workerd and cellb the patch never triggers: those queries do not fail there.
 */
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";

export const COMPAT_ENTRY = "/__webrun_entry.mjs";

export function compatEntrySource(entry: string, d1Bindings: string[]): string {
  const target = `./${entry.replace(/^\.?\/+/, "")}`;
  return `import * as mod from ${JSON.stringify(target)};
export * from ${JSON.stringify(target)};
const D1 = ${JSON.stringify(d1Bindings)};
const INTERNAL = /pragma_\\w+\\(\\s*'_(litestream|cf)_/i;
const empty = (m) => (m === "first" ? null : m === "raw" ? [] : { results: [], success: true, meta: {} });
function guard(st, sql) {
  for (const m of ["all", "run", "first", "raw"]) {
    const f = st[m];
    if (typeof f !== "function") continue;
    st[m] = async function (...a) {
      try {
        return await f.apply(this, a);
      } catch (e) {
        if (/not authorized/.test(String(e?.message)) && INTERNAL.test(sql)) return empty(m);
        throw e;
      }
    };
  }
  const bind = st.bind;
  if (typeof bind === "function") st.bind = function (...v) { return guard(bind.apply(this, v), sql); };
  return st;
}
const patched = new WeakSet();
function patch(env) {
  for (const name of D1) {
    const db = env?.[name];
    if (!db || typeof db !== "object" || patched.has(db) || typeof db.prepare !== "function") continue;
    patched.add(db);
    const prepare = db.prepare;
    try {
      db.prepare = function (sql) { return guard(prepare.call(this, sql), String(sql)); };
    } catch {}
  }
}
const d = mod.default;
const HANDLERS = ["fetch", "scheduled", "queue", "email", "tail", "trace", "alarm"];
let wrapped = d;
if (d && typeof d === "object") {
  wrapped = { ...d };
  for (const h of HANDLERS)
    if (typeof d[h] === "function")
      wrapped[h] = function (arg, env, ctx) { patch(env); return d[h].call(d, arg, env, ctx); };
}
export default wrapped;
`;
}

/** `files` with extra files laid over it (path → text), read-only for those. */
export function overlay(files: FilesApi, extra: Map<string, string>): FilesApi {
  const enc = new TextEncoder();
  const bytes = new Map([...extra].map(([p, t]) => [p, enc.encode(t)]));
  return {
    ...files,
    read: (path, o) => {
      const b = bytes.get(path);
      if (!b) return files.read(path, o);
      return (async function* () {
        const start = o?.start ?? 0;
        yield b.subarray(start, o?.length === undefined ? undefined : start + o.length);
      })();
    },
    stats: async (path) => {
      const b = bytes.get(path);
      return b ? { kind: "file", size: b.length, lastModified: 0 } : files.stats(path);
    },
    exists: async (path) => bytes.has(path) || files.exists(path),
    list: (path, o) => files.list(path, o) as AsyncIterable<FileInfo>,
    write: files.write.bind(files),
    mkdir: files.mkdir.bind(files),
    remove: files.remove.bind(files),
    move: files.move.bind(files),
    copy: files.copy.bind(files),
  };
}
