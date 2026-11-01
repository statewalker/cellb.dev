/**
 * A persistent cache of npm packages over any FilesApi (a SQLite one, `SqliteFilesApi`, on OPFS
 * in a browser worker or in a Durable Object's storage; a disk one on Node), and a parallel
 * prefetch into it.
 *
 * - `cachedSource(cache, inner)`: a webrun-modules `Source` that answers from the cache, and
 *   otherwise loads from `inner` (the npm registry) and writes the package to the cache. A
 *   package is kept unpacked under `/pkgs/<name>@<version>/`, so a bundler reads its files one
 *   by one from storage: nothing is held in memory.
 * - `prefetch(source, …)`: loads packages N at a time, either a recorded list (`lock`, from the
 *   last build) or, breadth-first, the dependency tree from the project's `package.json`. The
 *   bundler then finds them in the cache, instead of waiting on the registry once per import.
 */
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import type { Trace } from "./trace.js";

interface LoadedPackage {
  name: string;
  version: string;
  files: FilesApi;
  manifest: Record<string, unknown>;
}
export interface Source {
  matches(ref: { pkg?: string; url?: string }): boolean;
  load(ref: { pkg: string; version?: string }): Promise<LoadedPackage>;
}

/** `files` seen from `prefix`: paths of the view are paths below it. */
export function subtree(files: FilesApi, prefix: string): FilesApi {
  const p = (path: string) =>
    `${prefix}${path.startsWith("/") ? path : `/${path}`}`.replace(/\/$/, "") || "/";
  const back = (info: FileInfo): FileInfo => ({
    ...info,
    path: info.path.slice(prefix.length) || "/",
  });
  const view: Partial<FilesApi> = {
    read: (path, o) => files.read(p(path), o),
    write: (path, c) => files.write(p(path), c),
    mkdir: (path) => files.mkdir(p(path)),
    async *list(path, o) {
      for await (const info of files.list(p(path), o)) yield back(info);
    },
    stats: (path) => files.stats(p(path)),
    exists: (path) => files.exists(p(path)),
    remove: (path) => files.remove(p(path)),
  };
  return new Proxy(view as FilesApi, {
    get: (t, k) => (k in t ? t[k as keyof FilesApi] : (files as never)[k]),
  });
}

async function* walk(files: FilesApi, dir: string): AsyncGenerator<string> {
  for await (const e of files.list(dir)) {
    if (e.kind === "directory") yield* walk(files, e.path);
    else yield e.path;
  }
}
const enc = new TextEncoder();
const dec = new TextDecoder();
async function readJson<T>(files: FilesApi, path: string): Promise<T | undefined> {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  if (!chunks.length) return undefined;
  return JSON.parse(
    dec.decode(chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c]))),
  );
}
const isExact = (v?: string) => !!v && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v);

/**
 * Every `name@version` the source handed out (the next build's `lock`), and `flush()`: waits
 * for the packages fetched so far to be written to the cache.
 */
export type CachedSource = Source & { used: Set<string>; flush(): Promise<void> };

/**
 * Fetches a package and stores its pack in the cache by itself (a download worker): answers
 * the exact name and version it stored.
 */
export type Downloader = (ref: {
  pkg: string;
  version?: string;
}) => Promise<{ name: string; version: string }>;

export function cachedSource(
  cache: FilesApi,
  inner: Source,
  trace?: Trace,
  download?: Downloader,
): CachedSource {
  const used = new Set<string>();
  const loading = new Map<string, Promise<LoadedPackage>>();
  /** `name@range` → version, as resolved before (persisted: a warm cache needs no registry). */
  const ranges = new Map<string, string>();
  let indexLoaded: Promise<void> | undefined;
  const loadIndex = () =>
    (indexLoaded ??= readJson<Record<string, string>>(cache, "/index.json").then((j) => {
      for (const [k, v] of Object.entries(j ?? {})) ranges.set(k, v);
    }));
  let saving: Promise<void> = Promise.resolve();
  const pendingWrites: LoadedPackage[] = [];
  const saveIndex = () =>
    (saving = saving.then(() =>
      cache.write("/index.json", [enc.encode(JSON.stringify(Object.fromEntries(ranges)))]),
    ));

  const packPath = (name: string, version: string) => `/pkgs/${name}@${version}.pack`;
  const cached = async (name: string, version: string): Promise<LoadedPackage | undefined> => {
    const path = packPath(name, version);
    if (!(await cache.exists(path))) return undefined;
    const files = await openPack(cache, path);
    const manifest = (await readJson<Record<string, unknown>>(files, "/package.json")) ?? {};
    return { name, version, files, manifest };
  };

  const store = async (p: LoadedPackage): Promise<LoadedPackage> => {
    const t = performance.now();
    const { chunks, files, bytes } = await packOf(p.files);
    await cache.write(packPath(p.name, p.version), chunks);
    trace?.add(
      "packages",
      `cached ${p.name}@${p.version}`,
      { files, bytes },
      performance.now() - t,
    );
    return p;
  };

  return {
    used,
    flush: async () => {
      for (let p = pendingWrites.shift(); p; p = pendingWrites.shift())
        await store(p).catch((err) =>
          trace?.add("packages", `caching ${p?.name} failed`, { error: String(err) }),
        );
      await saving;
    },
    matches: (ref) => "pkg" in ref,
    load(ref) {
      const key = `${ref.pkg}@${ref.version ?? "latest"}`;
      let p = loading.get(key);
      if (!p) {
        p = (async () => {
          await loadIndex();
          const version = isExact(ref.version) ? ref.version : ranges.get(key);
          const hit = version && (await cached(ref.pkg, version));
          if (hit) return hit;
          if (download) {
            const t = performance.now();
            const got = await download(ref);
            trace?.add(
              "packages",
              `downloaded ${got.name}@${got.version}`,
              { range: ref.version },
              performance.now() - t,
            );
            ranges.set(key, got.version);
            void saveIndex();
            const stored = await cached(got.name, got.version);
            if (!stored)
              throw new Error(
                `${got.name}@${got.version}: not in the package store after its download`,
              );
            return stored;
          }
          const t = performance.now();
          const fetched = await inner.load(ref);
          trace?.add(
            "packages",
            `fetched ${fetched.name}@${fetched.version}`,
            { range: ref.version },
            performance.now() - t,
          );
          ranges.set(key, fetched.version);
          void saveIndex();
          const already = await cached(fetched.name, fetched.version);
          if (already) return already;
          // This build reads the fetched package from memory; it is written to the cache by
          // flush(), after the build: in a browser worker, SQLite and its compression share the
          // thread with esbuild-wasm, and writing during the build slowed it several times over.
          pendingWrites.push(fetched);
          return fetched;
        })();
        loading.set(key, p);
        p.then(
          (x) => used.add(`${x.name}@${x.version}`),
          () => loading.delete(key),
        );
      }
      return p;
    },
  };
}

/**
 * A package as ONE file (`<name>@<version>.pack`): a 4-byte header length, a JSON header
 * `{ path: [offset, length] }`, then the files' bytes. One write per package (a SQLite store
 * pays per write: tens of thousands of small files took minutes in a browser), and each file is
 * read alone, as a range of the pack (SqliteFilesApi reads only the blocks a range covers).
 */
export async function packOf(
  files: FilesApi,
): Promise<{ chunks: Uint8Array[]; files: number; bytes: number }> {
  const index: Record<string, [number, number]> = {};
  const body: Uint8Array[] = [];
  let offset = 0;
  for await (const path of walk(files, "/")) {
    const start = offset;
    for await (const c of files.read(path)) body.push(c), (offset += c.length);
    index[path] = [start, offset - start];
  }
  const header = enc.encode(JSON.stringify(index));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return { chunks: [len, header, ...body], files: Object.keys(index).length, bytes: offset };
}

/** A read-only FilesApi over a pack in `store`. */
export async function openPack(store: FilesApi, path: string): Promise<FilesApi> {
  const head: Uint8Array[] = [];
  for await (const c of store.read(path, { start: 0, length: 4 })) head.push(c);
  const n = new DataView(new Uint8Array(head.flatMap((c) => [...c])).buffer).getUint32(0);
  const hdr: Uint8Array[] = [];
  for await (const c of store.read(path, { start: 4, length: n })) hdr.push(c);
  const index = JSON.parse(dec.decode(new Uint8Array(hdr.flatMap((c) => [...c])))) as Record<
    string,
    [number, number]
  >;
  const base = 4 + n;
  const dirs = new Set<string>(["/"]);
  for (const p of Object.keys(index))
    for (let d = p.slice(0, p.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  const norm = (p: string) => (p.startsWith("/") ? p : `/${p}`).replace(/\/+$/, "") || "/";
  const readOnly = () => Promise.reject(new Error(`${path}: a package pack is read-only`));
  const api: Partial<FilesApi> = {
    async *read(p, o) {
      const e = index[norm(p)];
      if (!e) return;
      const start = Math.min(o?.start ?? 0, e[1]);
      const length = Math.min(o?.length ?? e[1] - start, e[1] - start);
      if (length > 0) yield* store.read(path, { start: base + e[0] + start, length });
    },
    async stats(p) {
      const k = norm(p);
      const e = index[k];
      if (e) return { kind: "file", size: e[1], lastModified: 0 };
      return dirs.has(k) ? { kind: "directory" } : undefined;
    },
    async exists(p) {
      const k = norm(p);
      return k in index || dirs.has(k);
    },
    async *list(p, o) {
      const d = norm(p);
      const prefix = d === "/" ? "/" : `${d}/`;
      const seen = new Set<string>();
      const out: FileInfo[] = [];
      for (const k of [...Object.keys(index), ...dirs]) {
        if (!k.startsWith(prefix) || k === d) continue;
        const rest = k.slice(prefix.length);
        if (!o?.recursive && rest.includes("/")) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        const name = k.slice(k.lastIndexOf("/") + 1);
        out.push(
          k in index
            ? { kind: "file", name, path: k, size: index[k][1], lastModified: 0 }
            : { kind: "directory", name, path: k },
        );
      }
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const e of out) if (!o?.after || e.path > o.after) yield e;
    },
    write: readOnly,
    mkdir: readOnly,
    remove: readOnly,
  };
  return api as FilesApi;
}

export interface PrefetchOptions {
  /** Packages to load at once (default 16). */
  concurrency?: number;
  /** Exact `name@version`s, from the last build: loaded as they are, no tree walk. */
  lock?: string[];
  /** Packages not to walk into: build tooling the server and client bundles never import. */
  skip?: (name: string) => boolean;
  /** Bound on the tree walk. */
  limit?: number;
  trace?: Trace;
}

export const BUILD_TOOLING =
  /^(typescript|vite|rollup|@rollup\/|esbuild|@esbuild\/|rolldown|@rolldown\/|sharp|@img\/|lightningcss|prettier|@types\/|vitest|@vitejs\/|@babel\/|babel-|wrangler|miniflare|workerd|@cloudflare\/(workerd|vite-plugin|kv-asset)|@astrojs\/(check|language-server|compiler-binding)|@oxc-|oxc-|@napi-rs\/|fsevents|chokidar|svgo|@shikijs\/|shiki)/;

/**
 * Loads packages `concurrency` at a time: the `lock` list, or else the dependency tree of
 * `manifest` (dependencies, optional and non-optional peer dependencies), breadth-first.
 * Returns the `name@version`s it loaded. Failures are recorded and skipped: the bundler
 * fetches what it still needs on demand.
 */
export async function prefetch(
  source: Source,
  manifest: { dependencies?: Record<string, string> },
  opts: PrefetchOptions = {},
): Promise<string[]> {
  const concurrency = opts.concurrency ?? 16;
  const skip = opts.skip ?? ((n: string) => BUILD_TOOLING.test(n));
  const limit = opts.limit ?? 2000;
  const queue: [string, string | undefined][] = opts.lock
    ? opts.lock.map((nv) => {
        const at = nv.lastIndexOf("@");
        return [nv.slice(0, at), nv.slice(at + 1)];
      })
    : Object.entries(manifest.dependencies ?? {}).filter(([n]) => !skip(n));
  const seenRange = new Set(queue.map(([n, r]) => `${n}@${r}`));
  const loaded = new Set<string>();
  const t0 = performance.now();
  let failures = 0;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [name, range] = item;
      try {
        const p = await source.load({ pkg: name, version: range });
        const id = `${p.name}@${p.version}`;
        if (loaded.has(id)) continue;
        loaded.add(id);
        if (opts.lock || loaded.size >= limit) continue;
        const m = p.manifest as Record<string, Record<string, string> | undefined>;
        const optionalPeers = new Set(
          Object.entries(
            (m.peerDependenciesMeta ?? {}) as unknown as Record<string, { optional?: boolean }>,
          )
            .filter(([, v]) => v?.optional)
            .map(([k]) => k),
        );
        const deps = { ...m.peerDependencies, ...m.optionalDependencies, ...m.dependencies };
        for (const [n, r] of Object.entries(deps)) {
          if (skip(n) || optionalPeers.has(n) || /^(workspace|link|file|git|https?):/.test(r))
            continue;
          const key = `${n}@${r}`;
          if (!seenRange.has(key)) seenRange.add(key), queue.push([n, r]);
        }
      } catch (err) {
        failures++;
        opts.trace?.add("packages", `prefetch ${name}@${range} failed`, {
          error: String((err as Error)?.message ?? err).slice(0, 300),
        });
      }
    }
  };
  // Workers wait for each other's discoveries: restart until the queue stays empty.
  while (queue.length) await Promise.all(Array.from({ length: concurrency }, worker));
  opts.trace?.add(
    "packages",
    `prefetched ${loaded.size} packages, ${concurrency} at a time${opts.lock ? " (from the lock)" : ""}`,
    { failures },
    performance.now() - t0,
  );
  return [...loaded];
}

/** The `name@version`s a bundle read, from its metafile's inputs (`npm:<name>@<version>/…`). */
export function lockOf(inputs: string[]): string[] {
  const out = new Set<string>();
  for (const id of inputs) {
    const m = /npm:((?:@[^/@]+\/)?[^/@]+@[^/]+)\//.exec(id);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}
