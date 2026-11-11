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

// createHash: SHA-256, synchronous as Node's is (Web Crypto's digest is async), for build-time
// code that names files or caches by a hash (EmDash 1.5's virtual modules hash their imports).
const crypto = `export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha256(bytes) {
  const l = bytes.length;
  const n = Math.ceil((l + 9) / 64) * 64;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[l] = 0x80;
  const v = new DataView(m.buffer);
  v.setUint32(n - 8, Math.floor(l / 0x20000000));
  v.setUint32(n - 4, (l * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = v.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (data, enc) => {
  if (typeof data === "string") {
    if (enc === "hex") return Uint8Array.from(data.match(/../g) ?? [], (x) => parseInt(x, 16));
    if (enc === "base64") return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new TextEncoder().encode(data);
  }
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("node:crypto Hash.update at build time takes a string or bytes");
};
const b64 = (b) => btoa(String.fromCharCode(...b));
const b64url = (b) => b64(b).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
// A raw digest whose toString(encoding) answers as Node's Buffer does (digest().toString("hex")).
class Digest extends Uint8Array {
  toString(enc) {
    if (enc === "hex") return hex(this);
    if (enc === "base64") return b64(this);
    if (enc === "base64url") return b64url(this);
    return new TextDecoder().decode(this);
  }
}
class Hash {
  constructor(algorithm) {
    if (String(algorithm).toLowerCase().replace("-", "") !== "sha256")
      throw new Error("node:crypto createHash(" + algorithm + ") at build time: only sha256 is supported");
    this.chunks = [];
  }
  update(data, enc) { this.chunks.push(bytesOf(data, enc)); return this; }
  digest(enc) {
    const all = new Uint8Array(this.chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const d = sha256(all);
    if (enc === "hex") return hex(d);
    if (enc === "base64") return b64(d);
    if (enc === "base64url") return b64url(d);
    return new Digest(d);
  }
}
export const createHash = (algorithm) => new Hash(algorithm);
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
