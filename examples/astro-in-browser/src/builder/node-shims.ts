/**
 * Node.js modules for code that runs at BUILD time in the builder's realm (astro.config.mjs
 * and the integrations it loads), over a synchronous virtual file system: the project under
 * `/app` and the packages the integrations read, under `/node_modules/<name>`, preloaded into
 * `globalThis.__astroVfs` (a Map of path → bytes). Writes go to the map too.
 */
export const VFS_GLOBAL = "__astroVfs";

const fs = `
const vfs = () => globalThis.${VFS_GLOBAL};
const norm = (p) => (typeof p === "string" ? p : p instanceof URL ? decodeURIComponent(p.pathname) : String(p)).replace(/\\/+$/, "") || "/";
const isDir = (p) => { const d = norm(p) + "/"; for (const k of vfs().keys()) if (k.startsWith(d)) return true; return false; };
const enoent = (p) => Object.assign(new Error("ENOENT: no such file or directory, " + p), { code: "ENOENT" });
export function existsSync(p) { p = norm(p); return vfs().has(p) || isDir(p); }
export function readFileSync(p, enc) {
  p = norm(p); const b = vfs().get(p); if (!b) throw enoent(p);
  const e = typeof enc === "string" ? enc : enc?.encoding; return e ? new TextDecoder().decode(b) : b;
}
export function writeFileSync(p, data) { vfs().set(norm(p), typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)); }
export function statSync(p) { p = norm(p); const f = vfs().get(p); if (!f && !isDir(p)) throw enoent(p);
  return { isFile: () => !!f, isDirectory: () => !f, size: f?.length ?? 0, mtimeMs: 0 }; }
export function readdirSync(p) { const d = norm(p) + "/"; const s = new Set(); for (const k of vfs().keys()) if (k.startsWith(d)) s.add(k.slice(d.length).split("/")[0]); return [...s]; }
export function mkdirSync() {}
export const promises = {
  readFile: async (p, e) => readFileSync(p, e), writeFile: async (p, d) => writeFileSync(p, d),
  mkdir: async () => {}, rename: async (a, b) => { const v = vfs().get(norm(a)); if (v) { vfs().set(norm(b), v); vfs().delete(norm(a)); } },
  unlink: async (p) => { vfs().delete(norm(p)); }, stat: async (p) => statSync(p), readdir: async (p) => readdirSync(p),
  access: async (p) => { if (!existsSync(p)) throw enoent(p); },
};
export default { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, promises };
`;

const fsPromises = `import fs from "node:fs"; const p = fs.promises; export default p;
export const { readFile, writeFile, mkdir, rename, unlink, stat, readdir, access } = p;`;

const path = `import * as p from "pathe"; export * from "pathe"; export const posix = p, win32 = p; export default { ...p, posix: p, win32: p };`;

const url = `
export const fileURLToPath = (u) => decodeURIComponent(new URL(String(u)).pathname);
export const pathToFileURL = (p) => new URL("file://" + encodeURI(p));
export const URL = globalThis.URL, URLSearchParams = globalThis.URLSearchParams;
export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
`;

/** \`createRequire(from)\`: \`require.resolve\` over the VFS with package \`exports\`; \`require\` of JSON. */
const moduleShim = `
import { exports as resolveExports } from "resolve.exports";
import fs from "node:fs";
const pkgOf = (spec) => { const parts = spec.split("/"); const n = spec.startsWith("@") ? 2 : 1; return { name: parts.slice(0, n).join("/"), sub: parts.slice(n).join("/") }; };
function resolveSpec(spec) {
  if (spec.startsWith("/")) return spec;
  if (spec.startsWith("node:")) return spec;
  const { name, sub } = pkgOf(spec);
  const root = "/node_modules/" + name;
  // A package not preloaded: its path by name (build-time code mostly hands these to Vite).
  if (!fs.existsSync(root + "/package.json")) return root + "/" + (sub || "index.js");
  const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
  let rel;
  if (sub === "package.json") rel = "package.json";
  else if (pkg.exports) rel = (resolveExports(pkg, sub ? "./" + sub : ".", { conditions: ["node", "import", "default"], unsafe: true }) ?? [])[0];
  else rel = sub || pkg.main || "index.js";
  if (!rel) throw Object.assign(new Error("Cannot find module '" + spec + "'"), { code: "MODULE_NOT_FOUND" });
  return root + "/" + rel.replace(/^\\.\\//, "");
}
export function createRequire() {
  const require = (spec) => { const p = resolveSpec(spec); if (p.endsWith(".json")) return JSON.parse(fs.readFileSync(p, "utf8")); throw new Error("require(" + spec + ") at build time is not supported"); };
  require.resolve = resolveSpec;
  return require;
}
export const builtinModules = [];
export default { createRequire, builtinModules };
`;

const crypto = `export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const createHash = () => { throw new Error("node:crypto createHash at build time is not supported"); };
export default { randomUUID, randomBytes, createHash };`;

const stub = (name: string) =>
  `const fail = () => { throw new Error("${name} is not available at build time in a browser"); };
export const request = fail, get = fail, createServer = fail, spawn = fail, execSync = fail, exec = fail;
export default new Proxy({}, { get: () => fail });`;

const process = `const p = globalThis.process ?? { env: {}, cwd: () => "/app", platform: "browser", versions: {}, argv: [] };
p.env ??= {}; p.cwd ??= () => "/app"; export default p; export const env = p.env, cwd = p.cwd, platform = "browser", versions = p.versions ?? {}, argv = [];`;

/** Sources of the node modules a build-time bundle imports (a function for webrun-bundler's `modules`). */
export function buildTimeNodeModule(spec: string): string | undefined {
  const name = spec.replace(/^node:/, "");
  if (
    spec.startsWith("node:") ||
    ["fs", "path", "url", "module", "crypto", "fs/promises"].includes(spec)
  )
    switch (name) {
      case "fs":
        return fs;
      case "fs/promises":
        return fsPromises;
      case "path":
        return path;
      case "url":
        return url;
      case "module":
        return moduleShim;
      case "crypto":
        return crypto;
      case "process":
        return process;
      default:
        return stub(spec);
    }
  return undefined;
}
