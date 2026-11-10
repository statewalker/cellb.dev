/**
 * Astro's configuration step, in the builder: bundles the project's `astro.config.mjs` (its
 * integrations included) for the builder's realm, evaluates it, and runs the integrations'
 * `astro:config:setup` and `astro:config:done` hooks with a stand-in for Astro's API. What they
 * register (routes, middleware, Vite plugins, renderers) is what the server build then uses.
 *
 * The adapter is cellb: `@astrojs/cloudflare` is replaced by a stub with the same name.
 */

import { bundle, type Esbuild, type Mount, type PackageStore } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { buildTimeNodeModule, VFS_GLOBAL } from "./node-shims.js";

export interface InjectedRoute {
  pattern: string;
  entrypoint: string;
  prerender?: boolean;
}
export interface VitePluginLike {
  name: string;
  resolveId?: (id: string, importer?: string, opts?: unknown) => unknown;
  load?: (id: string, opts?: unknown) => unknown;
  config?: unknown;
  configResolved?: (config: unknown) => unknown;
  buildStart?: () => unknown;
}
export interface IntegrationResult {
  config: Record<string, unknown>;
  routes: InjectedRoute[];
  middleware: { entrypoint: string; order: "pre" | "post" }[];
  plugins: VitePluginLike[];
  renderers: { name: string; serverEntrypoint: string; clientEntrypoint?: string }[];
}

async function* walk(files: FilesApi, dir: string): AsyncGenerator<string> {
  for await (const e of files.list(dir)) {
    if (e.kind === "directory") yield* walk(files, e.path);
    else yield e.path;
  }
}
async function readAll(files: FilesApi, path: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) out.set(c, at), (at += c.length);
  return out;
}

/**
 * The synchronous file system integrations read at build time: the project at `/app`, and the
 * named packages (as the project, or the package before them, depends on them) at
 * `/node_modules/<name>`. Returns the map and the packages' mounts by name.
 */
export async function preloadVfs(
  files: FilesApi,
  root: string,
  packages: PackageStore,
  chain: [name: string, importer?: string][],
  trace?: import("./trace.js").Trace,
): Promise<{ vfs: Map<string, Uint8Array>; mounts: Map<string, Mount> }> {
  const vfs = new Map<string, Uint8Array>();
  for await (const p of walk(files, root))
    vfs.set(`/app${p.slice(root.length)}`, await readAll(files, p));
  trace?.add("sources", `${vfs.size} project files`, {
    files: [...vfs.keys()],
    bytes: [...vfs.values()].reduce((n, b) => n + b.length, 0),
  });
  const project: Mount = { prefix: "~", files, root };
  const mounts = new Map<string, Mount>();
  for (const [name, importerName] of chain) {
    const importerMount = importerName ? mounts.get(importerName) : project;
    if (!importerMount) throw new Error(`preload ${name}: ${importerName} not loaded`);
    const m = await packages.get(name, {
      mount: importerMount,
      path: `${importerMount.root.replace(/\/$/, "")}/package.json`,
    });
    if (!m) throw new Error(`preload: no package ${name}`);
    mounts.set(name, m);
    const before = vfs.size;
    const base = m.root.replace(/\/$/, "");
    for await (const p of walk(m.files, m.root))
      vfs.set(`/node_modules/${name}${p.slice(base.length)}`, await readAll(m.files, p));
    trace?.add("packages", `preloaded ${name} as ${m.prefix} for build-time code`, {
      files: vfs.size - before,
      importer: importerName ?? "~",
    });
  }
  return { vfs, mounts };
}

/** Stand-ins for packages whose build-time side is Vite or Cloudflare tooling. */
const STUBS: Record<string, string> = {
  "@astrojs/cloudflare": `export default () => ({ name: "@astrojs/cloudflare", hooks: {} });`,
  "@astrojs/react": `export default () => ({ name: "@astrojs/react", hooks: { "astro:config:setup": ({ addRenderer }) => addRenderer({ name: "@astrojs/react", clientEntrypoint: "@astrojs/react/client.js", serverEntrypoint: "@astrojs/react/server.js" }) } });`,
  "astro/config": `export const defineConfig = (c) => c; export const fontProviders = new Proxy({}, { get: () => () => ({}) }); export const passthroughImageService = () => ({ entrypoint: "astro/assets/services/noop" }); export const sharpImageService = passthroughImageService; export const envField = new Proxy({}, { get: () => (o) => o });`,
};

/** Bundles and evaluates `astro.config.mjs`, then runs its integrations' config hooks. */
export async function runAstroConfig(opts: {
  esbuild: Esbuild;
  files: FilesApi;
  root: string;
  packages: PackageStore;
  vfs: Map<string, Uint8Array>;
  /** Evaluates an ES module's source (a Blob URL import in browsers, a data: URL on Node). */
  evaluate: (code: string) => Promise<Record<string, unknown>>;
  log?: (m: string) => void;
  trace?: import("./trace.js").Trace;
  /**
   * The session driver the build supplies (`{ driver, options }`), set in the config before the
   * integrations run, as an adapter's would be: EmDash checks for one in `config:setup`.
   */
  session?: { driver: string; options?: Record<string, unknown> };
}): Promise<IntegrationResult> {
  const g = globalThis as Record<string, unknown>;
  g[VFS_GLOBAL] = opts.vfs;
  g.process ??= { env: {} };
  const proc = g.process as { env: Record<string, string>; cwd?: () => string };
  proc.cwd = () => "/app";
  const built = await bundle({
    esbuild: opts.esbuild,
    files: opts.files,
    root: opts.root,
    entry: "/astro.config.mjs",
    packages: opts.packages,
    conditions: ["worker", "browser", "import"],
    platform: "browser",
    modules: (spec) => STUBS[spec] ?? buildTimeNodeModule(spec),
    // The integration finds its own files from its module URL (`createRequire(import.meta.url)`).
    define: {
      "import.meta.url": JSON.stringify("file:///node_modules/emdash/dist/astro/index.mjs"),
    },
    esbuildOptions: { mainFields: ["module", "main"] },
  });
  opts.log?.(`astro.config.mjs bundled: ${(built.code.length / 1e6).toFixed(2)} MB`);
  opts.trace?.add("config", "astro.config.mjs bundled for the builder's realm", {
    bytes: built.code.length,
    inputs: Object.keys(built.metafile.inputs).length,
    nodeShims: Object.keys(built.metafile.inputs).filter((i) => i.startsWith("webrun-virtual:")),
  });
  const mod = await opts.evaluate(built.code);
  const userConfig = (mod.default ?? {}) as Record<string, unknown>;

  const result: IntegrationResult = {
    config: {},
    routes: [],
    middleware: [],
    plugins: [],
    renderers: [],
  };
  let config: Record<string, unknown> = {
    root: new URL("file:///app/"),
    srcDir: new URL("file:///app/src/"),
    publicDir: new URL("file:///app/public/"),
    outDir: new URL("file:///app/dist/"),
    cacheDir: new URL("file:///app/node_modules/.astro/"),
    base: "/",
    trailingSlash: "ignore",
    output: "server",
    build: {
      format: "directory",
      client: new URL("file:///app/dist/client/"),
      server: new URL("file:///app/dist/server/"),
    },
    server: {},
    security: {},
    markdown: {},
    image: {},
    experimental: {},
    devToolbar: { enabled: false },
    prefetch: false,
    session: opts.session ? { ...opts.session } : {},
    vite: {},
    ...userConfig,
    integrations:
      (userConfig.integrations as unknown[] | undefined)?.flat(Infinity).filter(Boolean) ?? [],
  };
  const logger = {
    info: (m: string) => opts.log?.(m),
    warn: (m: string) => opts.log?.(`warn: ${m}`),
    error: (m: string) => opts.log?.(`error: ${m}`),
    debug() {},
    fork() {
      return logger;
    },
  };
  type Integration = {
    name: string;
    hooks: Record<string, (p: Record<string, unknown>) => unknown>;
  };
  const integrations = config.integrations as Integration[];
  for (const i of integrations) {
    await i.hooks["astro:config:setup"]?.({
      config,
      command: "build",
      isRestart: false,
      logger,
      injectRoute: (r: InjectedRoute) => result.routes.push(r),
      addMiddleware: (m: { entrypoint: string; order: "pre" | "post" }) =>
        result.middleware.push(m),
      addRenderer: (r: IntegrationResult["renderers"][number]) => result.renderers.push(r),
      updateConfig: (c: Record<string, unknown>) => {
        const vite = c.vite as { plugins?: unknown[] } | undefined;
        if (vite?.plugins)
          result.plugins.push(...(vite.plugins.flat(Infinity).filter(Boolean) as VitePluginLike[]));
        config = { ...config, ...c, vite: { ...(config.vite as object), ...(vite ?? {}) } };
        return config;
      },
      addWatchFile() {},
      injectScript() {},
      addClientDirective() {},
      addDevToolbarApp() {},
      createCodegenDir: () => new URL("file:///app/node_modules/.astro/"),
    });
    opts.log?.(`integration ${i.name}: config:setup done`);
  }
  for (const i of integrations)
    await i.hooks["astro:config:done"]?.({
      config,
      logger,
      setAdapter() {},
      injectTypes: () => new URL("file:///app/.astro/types.d.ts"),
      buildOutput: "server",
    });
  result.config = config;
  opts.trace?.add("integrations", `${integrations.map((i) => i.name).join(", ")}`, {
    routes: result.routes.length,
    middleware: result.middleware,
    plugins: result.plugins.map((p) => p.name),
    renderers: result.renderers,
    image: config.image,
    session: config.session,
  });
  for (const p of result.plugins) {
    const hook = p.configResolved as
      | ((c: unknown) => unknown)
      | { handler: (c: unknown) => unknown }
      | undefined;
    const fn = typeof hook === "function" ? hook : hook?.handler;
    await fn?.call(p, {
      command: "build",
      root: "/app",
      build: { ssr: true },
      env: {},
      plugins: result.plugins,
    });
    const start = p.buildStart as (() => unknown) | { handler: () => unknown } | undefined;
    await (typeof start === "function" ? start : start?.handler)?.call(p);
  }
  return result;
}
