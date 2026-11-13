/**
 * workerd's `/bundle` for `node:fs` (nodejs_compat): a read-only directory of the Worker's own
 * modules. wrangler uploads each non-JS module a bundle imports (a `.wasm`, a Text or Data file)
 * as a module named `<sha1 of its bytes>-<file name>`, and Worker code can read it there
 * (Kitesurf reads its wasm with `fs.readFileSync("/bundle/…")`).
 *
 * The bundle's rule modules (module-rules.ts) register their bytes here when they are evaluated,
 * under the same names. `bundleFs(base)` wraps a `node:fs` (Node's own, or the browser's, which
 * has no file system) so that paths under `/bundle` read this registry and the rest go to `base`.
 * The registry is the realm's, keyed by content hash, so bundles that share a realm share files.
 */

export const BUNDLE_DIR = "/bundle";

type Entry = Uint8Array | (() => Uint8Array);
const REGISTRY = "__cellsBundleFiles";

/** The realm's `/bundle` files: name → bytes, or a function that makes them. */
export function bundleFiles(): Map<string, Entry> {
  const g = globalThis as Record<string, unknown>;
  g[REGISTRY] ??= new Map<string, Entry>();
  return g[REGISTRY] as Map<string, Entry>;
}

/** Registers `/bundle/<name>` (what a rule module calls). Returns `bytes`. */
export function registerBundleFile<T extends Entry>(name: string, bytes: T): T {
  bundleFiles().set(name, bytes);
  return bytes;
}

/** The file name under `/bundle` of `path` ("" for `/bundle` itself), or `undefined` elsewhere. */
function bundleName(path: unknown): string | undefined {
  let p: string;
  if (typeof path === "string") p = path;
  else if (path instanceof URL) {
    if (path.protocol !== "file:") return undefined;
    p = decodeURIComponent(path.pathname);
  } else if (path instanceof Uint8Array) p = new TextDecoder().decode(path);
  else return undefined;
  p = p.replace(/\/+/g, "/").replace(/\/$/, "");
  if (p === BUNDLE_DIR) return "";
  return p.startsWith(`${BUNDLE_DIR}/`) ? p.slice(BUNDLE_DIR.length + 1) : undefined;
}

const fsError = (code: string, syscall: string, path: unknown) => {
  const text =
    code === "ENOENT"
      ? "no such file or directory"
      : code === "EISDIR"
        ? "illegal operation on a directory"
        : "not a directory";
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${String(path)}'`), {
    code,
    syscall,
    path: String(path),
    errno: code === "ENOENT" ? -2 : code === "EISDIR" ? -21 : -20,
  });
};

function bytesOf(name: string, syscall: string, path: unknown): Uint8Array {
  const entry = bundleFiles().get(name);
  if (entry === undefined) throw fsError("ENOENT", syscall, path);
  return typeof entry === "function" ? entry() : entry;
}

/** Node's Buffer where the realm has one, as `readFileSync` returns; else the bytes. */
function buffer(bytes: Uint8Array): Uint8Array {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  return B ? B.from(bytes) : bytes.slice();
}

function decode(bytes: Uint8Array, options: unknown): Uint8Array | string {
  const encoding =
    typeof options === "string" ? options : (options as { encoding?: string })?.encoding;
  if (!encoding || encoding === "buffer") return buffer(bytes);
  const b = buffer(bytes) as Uint8Array & { toString?(enc: string): string };
  return (globalThis as { Buffer?: unknown }).Buffer && b.toString
    ? b.toString(encoding)
    : new TextDecoder(encoding === "utf-8" ? "utf8" : encoding).decode(bytes);
}

const MTIME = new Date(0);
function stats(kind: "file" | "dir", size: number) {
  return {
    dev: 0,
    ino: 0,
    mode: kind === "dir" ? 0o40555 : 0o100444,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: MTIME,
    mtime: MTIME,
    ctime: MTIME,
    birthtime: MTIME,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

const dirent = (name: string) => ({
  name,
  parentPath: BUNDLE_DIR,
  path: BUNDLE_DIR,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => false,
});

// The synchronous operations on `/bundle`, by name; each throws as Node's does.
const sync = {
  existsSync: (name: string) => name === "" || bundleFiles().has(name),
  readFileSync: (name: string, path: unknown, options?: unknown) => {
    if (name === "") throw fsError("EISDIR", "read", path);
    return decode(bytesOf(name, "open", path), options);
  },
  statSync: (name: string, path: unknown, options?: unknown) => {
    if (name === "") return stats("dir", 0);
    // `throwIfNoEntry: false`: a missing file is `undefined`, as libraries probing for one expect.
    if (
      !bundleFiles().has(name) &&
      (options as { throwIfNoEntry?: boolean })?.throwIfNoEntry === false
    )
      return undefined;
    return stats("file", bytesOf(name, "stat", path).byteLength);
  },
  readdirSync: (name: string, path: unknown, options?: unknown) => {
    if (name !== "") {
      bytesOf(name, "scandir", path);
      throw fsError("ENOTDIR", "scandir", path);
    }
    const names = [...bundleFiles().keys()].sort();
    return (options as { withFileTypes?: boolean })?.withFileTypes ? names.map(dirent) : names;
  },
  accessSync: (name: string, path: unknown) => {
    if (name !== "" && !bundleFiles().has(name)) throw fsError("ENOENT", "access", path);
  },
};

type AnyFn = (...args: any[]) => any;

/**
 * `base` (a `node:fs`) with `/bundle` paths answered from the registry: `existsSync`,
 * `readFileSync`, `statSync`, `lstatSync`, `readdirSync`, `accessSync`, their callback forms and
 * `promises`. Other paths, and every other function, are `base`'s.
 */
export function bundleFs<T extends Record<string, any>>(base: T): Record<string, unknown> {
  const over = (op: keyof typeof sync, own: AnyFn | undefined) =>
    function (this: unknown, path: unknown, ...rest: unknown[]) {
      const name = bundleName(path);
      if (name === undefined) return own?.call(this, path, ...rest);
      return (sync[op] as AnyFn)(name, path, ...rest);
    };
  // Node's callback form: (path, [options], callback).
  const callback = (op: keyof typeof sync, own: AnyFn | undefined) =>
    function (this: unknown, path: unknown, ...rest: unknown[]) {
      const name = bundleName(path);
      if (name === undefined) return own?.call(this, path, ...rest);
      const cb = rest.pop() as AnyFn;
      let result: unknown;
      try {
        result = (sync[op] as AnyFn)(name, path, ...rest);
      } catch (e) {
        return queueMicrotask(() => cb(e));
      }
      queueMicrotask(() => (op === "accessSync" ? cb(null) : cb(null, result)));
    };
  const p = (base.promises ?? {}) as Record<string, AnyFn>;
  return {
    existsSync: over("existsSync", base.existsSync),
    readFileSync: over("readFileSync", base.readFileSync),
    statSync: over("statSync", base.statSync),
    lstatSync: over("statSync", base.lstatSync),
    readdirSync: over("readdirSync", base.readdirSync),
    accessSync: over("accessSync", base.accessSync),
    readFile: callback("readFileSync", base.readFile),
    stat: callback("statSync", base.stat),
    lstat: callback("statSync", base.lstat),
    readdir: callback("readdirSync", base.readdir),
    access: callback("accessSync", base.access),
    promises: bundleFsPromises(p),
  };
}

/** `node:fs/promises` with `/bundle` paths answered from the registry. */
export function bundleFsPromises<T extends Record<string, any>>(base: T): Record<string, unknown> {
  const promised = (op: keyof typeof sync, own: AnyFn | undefined) =>
    async function (this: unknown, path: unknown, ...rest: unknown[]) {
      const name = bundleName(path);
      if (name === undefined) return own?.call(this, path, ...rest);
      const result = (sync[op] as AnyFn)(name, path, ...rest);
      return op === "accessSync" ? undefined : result;
    };
  return {
    ...base,
    readFile: promised("readFileSync", base.readFile),
    stat: promised("statSync", base.stat),
    lstat: promised("statSync", base.lstat),
    readdir: promised("readdirSync", base.readdir),
    access: promised("accessSync", base.access),
  };
}
