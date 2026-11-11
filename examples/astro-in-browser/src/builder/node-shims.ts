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
// SHA-256, synchronous as node's is (SubtleCrypto is async): EmDash 1.5 hashes its generated
// plugins module with it at build time. Other digests are not needed by build-time code yet.
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256(m) {
  const l = m.length, n = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(n);
  b.set(m); b[l] = 0x80;
  const dv = new DataView(b.buffer);
  dv.setUint32(n - 8, Math.floor(l / 0x20000000)); dv.setUint32(n - 4, (l << 3) >>> 0);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const W = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], c = W[i - 2];
      W[i] = W[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + W[i - 7] + (r(c, 17) ^ r(c, 19) ^ (c >>> 10));
    }
    let [A, B, C, D, E, F, G, X] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (X + (r(E, 6) ^ r(E, 11) ^ r(E, 25)) + ((E & F) ^ (~E & G)) + K[i] + W[i]) >>> 0;
      const t2 = ((r(A, 2) ^ r(A, 13) ^ r(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>> 0;
      X = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    H[0] += A; H[1] += B; H[2] += C; H[3] += D; H[4] += E; H[5] += F; H[6] += G; H[7] += X;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
const encode = (d, enc) => {
  if (enc === "hex") return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (enc === "base64" || enc === "base64url") {
    const s = btoa(String.fromCharCode(...d));
    return enc === "base64" ? s : s.replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  if (enc) throw new Error("node:crypto digest encoding " + enc + " is not supported at build time");
  return d;
};
export const createHash = (algorithm) => {
  if (String(algorithm).toLowerCase().replace("-", "") !== "sha256")
    throw new Error("node:crypto createHash(" + algorithm + ") at build time is not supported (sha256 is)");
  const parts = [];
  const hash = {
    update(data) { parts.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)); return hash; },
    digest(enc) {
      const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      return encode(sha256(all), enc);
    },
  };
  return hash;
};
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
