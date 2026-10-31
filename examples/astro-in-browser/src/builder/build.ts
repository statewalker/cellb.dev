/**
 * An Astro SSR build that runs wherever esbuild-wasm does, a browser included: it reads the
 * project from a FilesApi, takes `astro` and its dependencies from a PackageStore (the npm
 * registry, fetched on demand), compiles `.astro` with Astro's compiler, and writes ONE Worker
 * module: Astro's `App`, a manifest of the project's routes, and every page, bundled.
 *
 * It does what Astro's build does for an on-demand (`output: "server"`) site with a fetch-style
 * adapter: routes from `src/pages`, `src/middleware.ts`, components' styles inlined per route.
 * It does not do what Astro's Vite plugins add on top: integrations, content collections,
 * `astro:assets`, client islands, prerendering, CSS bundling of imported `.css` files.
 */

import { bundle, type Esbuild, type Mount, type PackageStore } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { astroModule } from "./astro-modules.js";
import {
  type AstroTransform,
  astroPlugin,
  type CompiledComponent,
  clientPartsOf,
  compileAstro,
} from "./astro-plugin.js";
import type { IntegrationResult } from "./integrations.js";
import { type ClientAssets, pathsPlugin } from "./paths-plugin.js";
import { projectRoutes, type RouteData, routeFromPattern, sortRoutes } from "./routes.js";
import { inputsByPackage, resolutionTrace, type Trace } from "./trace.js";
import { tracedPackages } from "./traced-packages.js";
import { vitePluginsAdapter } from "./vite-adapter.js";

export interface AstroBuildOptions {
  esbuild: Esbuild;
  /** Astro's compiler (`transform` of `@astrojs/compiler-rs`). */
  transform: AstroTransform;
  files: FilesApi;
  /** The project's directory in `files`. */
  root: string;
  packages: PackageStore;
  /** Progress, for a UI. */
  log?: (message: string) => void;
  /** What the integrations registered (`runAstroConfig`). */
  integration?: IntegrationResult;
  /** Packages preloaded by name (`preloadVfs`): where `/node_modules/<name>/…` paths go. */
  nodeMounts?: Map<string, Mount>;
  /** Modules the runtime provides (`cellbHostModule` of `@statewalker/cellb/host-modules`). */
  hostModules?: (spec: string) => string | undefined;
  /** A module whose exports replace the Workers globals (`cells:globals`). */
  inject?: string[];
  /** Records every step (`Trace`). */
  trace?: Trace;
  /**
   * Called after the server bundle and after the client bundles: the caller may release
   * esbuild's memory there (esbuild-wasm's grows during a bundle and never shrinks; a
   * restarted instance starts small).
   */
  release?: () => Promise<void>;
  /**
   * The project's own Worker entry (wrangler's `main`, `src/worker.ts`), when it wraps the
   * adapter's handler (EmDash's adds `scheduled()` for its cron trigger and exports
   * `PluginBridge`): bundled as the entry, its `@astrojs/cloudflare/entrypoints/server` and
   * `astro/app/entrypoint` backed by this build's app.
   */
  main?: string;
  /** Astro session driver config (`{ driver, options }`), for the manifest. */
  session?: { driver: string; options?: Record<string, unknown> };
}

export interface AstroBuildResult {
  /** The Worker module (ES module, `export default { fetch }`). */
  code: string;
  routes: RouteData[];
  /** Compiled components by file id, with their styles. */
  components: Map<string, CompiledComponent>;
  /** Client files to serve (`?url` imports), by URL path. */
  clientAssets: ClientAssets;
  /** Files the bundle read, by id: what a rebuild depends on. */
  inputs: string[];
  ms: number;
}

const exists = async (files: FilesApi, path: string) => !!(await files.stats(path));

/** Records the packages the bundler loads, so `.astro` files inside them can be read too. */
function recording(store: PackageStore, mounts: Map<string, Mount>): PackageStore {
  return {
    async get(name, importer) {
      const m = await store.get(name, importer);
      if (m) mounts.set(m.prefix, m);
      return m;
    },
  };
}

export async function buildAstroApp(opts: AstroBuildOptions): Promise<AstroBuildResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const root = opts.root.replace(/\/$/, "") || "/";
  const integ = opts.integration;
  const image = (integ?.config.image ?? {}) as {
    endpoint?: { entrypoint: string; route?: string };
  };
  const routes = sortRoutes([
    ...(await projectRoutes(opts.files, root)),
    ...(integ?.routes ?? []).map((r) => routeFromPattern(r.pattern, r.entrypoint)),
    ...(image.endpoint
      ? [routeFromPattern(image.endpoint.route ?? "/_image", image.endpoint.entrypoint)]
      : []),
  ]);
  opts.trace?.add("routes", `${routes.length} routes`, {
    routes: routes.map((r) => ({
      route: r.route,
      type: r.type,
      origin: r.origin,
      component: r.component,
      pattern: r.pattern,
    })),
  });
  log(
    `${routes.length} routes${routes.length > 12 ? "" : `: ${routes.map((r) => r.route).join(", ")}`}`,
  );
  const middleware = (await exists(opts.files, `${root}/src/middleware.ts`))
    ? "./src/middleware.ts"
    : (await exists(opts.files, `${root}/src/middleware.js`))
      ? "./src/middleware.js"
      : undefined;

  const mounts = new Map<string, Mount>([["~", { prefix: "~", files: opts.files, root }]]);
  const hasLiveConfig = await exists(opts.files, `${root}/src/live.config.ts`);
  const clientAssets: ClientAssets = new Map();
  const components = new Map<string, CompiledComponent>();

  // The manifest, with each route's styles filled in at runtime from the compiled components
  // the route's page imports (the bundle knows them only once it is built).
  // A project file (`src/pages/…`), a package file (`/node_modules/…`), or a package specifier.
  const importPath = (c: string) => (c.startsWith("src/") ? `./${c}` : c);
  const pages = routes.map(
    (r) =>
      `  [${JSON.stringify(r.component)}, () => import(${JSON.stringify(importPath(r.component))}).then((m) => ({ page: () => m }))],`,
  );
  const mw = integ?.middleware ?? [];
  const pre = mw.filter((m) => m.order === "pre").map((m) => m.entrypoint);
  const post = mw.filter((m) => m.order === "post").map((m) => m.entrypoint);
  const chain = [...pre, ...(middleware ? [middleware] : []), ...post];
  const middlewareModule = `import { sequence } from "astro/virtual-modules/middleware.js";
${chain.map((m, i) => `import { onRequest as m${i} } from ${JSON.stringify(m)};`).join("\n")}
export const onRequest = sequence(${chain.map((_, i) => `m${i}`).join(", ")});`;
  const renderers = integ?.renderers ?? [];
  // `clientAssets` and the renderers are needed by the client build below.
  const renderersModule = `${renderers.map((r, i) => `import r${i} from ${JSON.stringify(r.serverEntrypoint)};`).join("\n")}
export const renderers = [${renderers.map((r, i) => `Object.assign(${JSON.stringify(r)}, { ssr: r${i} })`).join(", ")}];`;
  const entry = `
import { App } from "astro/app";
import { deserializeManifest } from "astro/app/manifest";
import { DefaultFetchHandler } from "astro/app/fetch/default-handler";
import { routeStyles, entryModules, inlinedScripts } from "virtual:astro-in-browser/styles";
import loadDirective from "astro/runtime/client/load.prebuilt.js";
import idleDirective from "astro/runtime/client/idle.prebuilt.js";
import visibleDirective from "astro/runtime/client/visible.prebuilt.js";
import mediaDirective from "astro/runtime/client/media.prebuilt.js";
import onlyDirective from "astro/runtime/client/only.prebuilt.js";
import { renderers } from "virtual:astro-in-browser/renderers";

const routes = ${JSON.stringify(routes)};
const serialized = {
  rootDir: "file:///", srcDir: "file:///src/", cacheDir: "file:///.astro/", outDir: "file:///dist/",
  publicDir: "file:///public/", buildClientDir: "file:///dist/client/", buildServerDir: "file:///dist/server/",
  adapterName: "astro-in-browser", assetsDir: "_astro",
  routes: routes.map((routeData) => ({ file: "", links: [], scripts: [], styles: routeStyles(routeData.component), routeData })),
  serverLike: true, middlewareMode: "classic", base: "/", trailingSlash: "ignore", compressHTML: "jsx",
  componentMetadata: [], renderers: [], clientDirectives: [], entryModules: {}, inlinedScripts: [], assets: [],
  buildFormat: "directory", checkOrigin: false, actionBodySizeLimit: 1048576, serverIslandBodySizeLimit: 1048576,
  allowedDomains: [], key: "${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}",
  image: ${JSON.stringify({ ...image, service: undefined })}, ${opts.session ? `sessionConfig: ${JSON.stringify(opts.session)},` : ""} devToolbar: { enabled: false, debugInfoOutput: "" }, logLevel: "info", shouldInjectCspMetaTags: false,
};
const pageMap = new Map([
${pages.join("\n")}
]);
const manifest = Object.assign(deserializeManifest(serialized), {
  entryModules,
  inlinedScripts: new Map(inlinedScripts),
  clientDirectives: new Map([["load", loadDirective], ["idle", idleDirective], ["visible", visibleDirective], ["media", mediaDirective], ["only", onlyDirective]]),
  renderers,
  pageMap,
  ${opts.session ? `sessionDriver: () => import(${JSON.stringify(opts.session.driver)}),` : ""}
  actions: async () => ({ server: {} }),
  middleware: () => import("virtual:astro-in-browser/middleware"),
  serverIslandMappings: async () => ({ serverIslandMap: new Map(), serverIslandNameMap: new Map() }),
});
const app = new App(manifest);
app.setFetchHandler(new DefaultFetchHandler());
export { app };

export default {
  async fetch(request, env, ctx) {
    // addCookieHeader: what routes set with Astro.cookies (the session id, EmDash's setup nonce)
    // becomes Set-Cookie, as an adapter's handler does it.
    const res = await app.render(request, {
      addCookieHeader: true,
      locals: { runtime: { env, ctx } },
      waitUntil: ctx?.waitUntil ? (p) => ctx.waitUntil(p) : undefined,
    });
    if (!res.body) return res;
    // A body that fails mid-stream reaches the client as a network error with no cause: log it.
    const [out, watch] = res.body.tee();
    watch.pipeTo(new WritableStream()).catch((err) => console.error("astro-in-browser: " + request.method + " " + new URL(request.url).pathname + " body failed:", err));
    return new Response(out, res);
  },
};
`;
  // What is only known once the server bundle is built (each route's styles, from its import
  // graph) and once the client is built (entryModules, inlinedScripts) is read from a global
  // that a one-line prelude sets: one server bundling pass instead of two.
  const styles = () =>
    `const g = globalThis.__astroInBrowserBuild ?? { styles: {}, entryModules: {}, inlinedScripts: [] };
export const routeStyles = (c) => (g.styles[c] ?? []).map((content) => ({ type: "inline", content }));
export const entryModules = g.entryModules;
export const inlinedScripts = g.inlinedScripts;`;
  let pageStyles: Record<string, string[]> = {};
  let client: ClientBuild = { entryModules: {}, inlinedScripts: [] };

  const run = () =>
    bundle({
      esbuild: opts.esbuild,
      sourcemap: false, // a 26 MB bundle's map (with every source) would double the memory
      files: opts.files,
      root,
      entry: "/.astro-in-browser-entry.js",
      packages: recording(
        opts.trace ? tracedPackages(opts.packages, opts.trace) : opts.packages,
        mounts,
      ),
      // "module" as Vite has it: packages whose "import" build is CommonJS-backed (tslib 2.3) ship ESM there.
      conditions: ["workerd", "worker", "browser", "module"],
      external: ["cloudflare:*", "node:*"],
      modules: (spec) => {
        switch (spec) {
          case "virtual:astro-in-browser/entry":
            return entry;
          case "virtual:astro-in-browser/styles":
            return styles();
          case "virtual:astro-in-browser/middleware":
            return middlewareModule;
          case "virtual:astro-in-browser/renderers":
            return renderersModule;
          // The adapter, as a project's own entry reaches it (`main`): this build's handler and app.
          case "@astrojs/cloudflare/entrypoints/server":
            return opts.main
              ? `export { default } from "virtual:astro-in-browser/entry";`
              : undefined;
          case "astro/app/entrypoint":
            return opts.main
              ? `import { app } from "virtual:astro-in-browser/entry";\nexport const createApp = () => app;`
              : undefined;
        }
        return astroModule(spec, { root, hasLiveConfig, image }) ?? opts.hostModules?.(spec);
      },
      inject: opts.inject,
      // What Vite defines for a production server build (Astro and integrations read it).
      define: {
        "import.meta.env": JSON.stringify({
          MODE: "production",
          DEV: false,
          PROD: true,
          SSR: true,
          BASE_URL: "/",
          ASSETS_PREFIX: undefined,
        }),
      },
      lowerAwait: !!opts.hostModules,
      esbuildOptions: {
        // Minified (whitespace and syntax; names kept: Astro and React read function names):
        // a smaller module for the shard to parse and hold.
        minifyWhitespace: true,
        minifySyntax: true,
        keepNames: true,
        plugins: [
          pathsPlugin({
            root,
            packages: opts.packages,
            nodeMounts: opts.nodeMounts ?? new Map(),
            mounts,
            components,
            clientAssets,
            builtin: (n) => opts.hostModules?.(`node:${n}`),
            trace: opts.trace,
          }),
          vitePluginsAdapter(integ?.plugins ?? [], opts.trace),
          astroPlugin({ transform: opts.transform, mounts, components, trace: opts.trace }),
        ],
      },
    });

  // The entry is a host module, not a file: give the bundler a file that imports it.
  const main = opts.main && JSON.stringify(`./${opts.main.replace(/^\.?\//, "")}`);
  await opts.files.write(`${root}/.astro-in-browser-entry.js`, [
    new TextEncoder().encode(
      main
        ? `export * from ${main};\nexport { default } from ${main};\n`
        : `export { default } from "virtual:astro-in-browser/entry";\n`,
    ),
  ]);
  // The client build reads the islands and scripts of every component, compiled up front
  // (scanComponents: well under a second): it does not wait on the server bundle's graph, so it
  // can run in a worker of its own. In ONE worker, running both bundles at once does not help:
  // esbuild-wasm is single-threaded (measured: 73 s + 108 s together vs 40 s + 42 s in turn).
  const scanned = await scanComponents(opts, root, mounts);
  log(`scanned ${scanned.size} components; bundling the server`);
  const timed = <T>(what: string, fn: () => Promise<T>) =>
    opts.trace ? opts.trace.time("bundle", what, fn) : fn();
  const first = await timed("server bundle", run);
  await opts.release?.();
  log("bundling the client (islands, renderers' client entrypoints, component scripts)");
  const clientBuilt = await timed("client bundle", () =>
    buildClient({ ...opts, root, components: scanned, renderers, clientAssets, mounts }),
  );
  await opts.release?.();
  client = clientBuilt;
  pageStyles = stylesByPage(first.metafile, routes, components);
  opts.trace?.add("bundle", "client build", {
    entryModules: client.entryModules,
    scripts: client.inlinedScripts.map(([k, v]) => [k, v.length]),
  });
  const result = first;
  const prelude = `globalThis.__astroInBrowserBuild = ${JSON.stringify({ styles: pageStyles, entryModules: client.entryModules, inlinedScripts: client.inlinedScripts })};\n`;
  if (opts.trace) {
    opts.trace.add("bundle", "inputs by package", { packages: inputsByPackage(result.metafile) });
    opts.trace.add("bundle", "resolution graph", { edges: resolutionTrace(result.metafile) });
    opts.trace.add(
      "bundle",
      "styles by route",
      Object.fromEntries(Object.entries(pageStyles).map(([k, v]) => [k, v.map((c) => c.length)])),
    );
    opts.trace.add("bundle", "external imports left", {
      externals: resolutionTrace(result.metafile)
        .filter((e) => e.external)
        .map((e) => `${e.specifier} (from ${e.importer})`),
    });
  }
  return {
    code: prelude + result.code,
    routes,
    components,
    clientAssets,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
    ms: Date.now() - started,
  };
}

/**
 * Islands and scripts of every `.astro` file in the project's `src/` and in the packages the
 * integrations load (`nodeMounts`), compiled ahead of the bundles. A component no route uses
 * only adds to the client bundle.
 */
async function scanComponents(
  o: AstroBuildOptions,
  root: string,
  mounts: Map<string, Mount>,
): Promise<Map<string, CompiledComponent>> {
  const out = new Map<string, CompiledComponent>();
  const trees: [Mount, string][] = [[{ prefix: "~", files: o.files, root }, `${root}/src`]];
  for (const m of o.nodeMounts?.values() ?? []) {
    mounts.set(m.prefix, m);
    trees.push([m, m.root]);
  }
  const t = performance.now();
  for (const [m, dir] of trees) {
    const base = m.root.replace(/\/$/, "");
    for await (const path of walkFiles(m.files, dir)) {
      if (!path.endsWith(".astro") || path.includes("/node_modules/")) continue;
      const id = `${m.prefix}${path.slice(base.length)}`;
      const chunks: Uint8Array[] = [];
      for await (const c of m.files.read(path)) chunks.push(c);
      const source = new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
      const r = compileAstro(o.transform, id, source);
      out.set(id, { css: [], containsHead: false, propagation: false, ...clientPartsOf(r) });
    }
  }
  o.trace?.add(
    "transform",
    `scanned ${out.size} components for the client build`,
    {
      islands: [...out.values()].flatMap((c) => c.islands ?? []),
    },
    performance.now() - t,
  );
  return out;
}

async function* walkFiles(files: FilesApi, dir: string): AsyncGenerator<string> {
  for await (const e of files.list(dir)) {
    if (e.kind === "directory") yield* walkFiles(files, e.path);
    else yield e.path;
  }
}

interface ClientBuild {
  entryModules: Record<string, string>;
  inlinedScripts: [string, string][];
}

/**
 * The browser side: one shared bundle of every island component and every renderer's client
 * entrypoint (one React for all), with a tiny module per specifier re-exporting its part (what
 * Astro's `entryModules` points at); and each component `<script>`, bundled on its own and
 * inlined (Astro's `inlinedScripts`).
 */
const CLIENT_MODULES: Record<string, string> = {
  "astro:transitions/client": `export { navigate, supportsViewTransitions, transitionEnabledOnThisPage } from "astro/virtual-modules/transitions-router.js";
export * from "astro/virtual-modules/transitions-types.js";
export { TransitionBeforePreparationEvent, TransitionBeforeSwapEvent } from "astro/virtual-modules/transitions-events.js";
export { swapFunctions } from "astro/virtual-modules/transitions-swap-functions.js";`,
  // No adapter client config here (cellb is the adapter): no extra headers.
  "virtual:astro:adapter-config/client": "export const internalFetchHeaders = {};",
};

/** The globals Astro's prefetch and transitions plugins substitute, from the config. */
function prefetchDefines(config: Record<string, unknown> | undefined): Record<string, string> {
  const prefetch = config?.prefetch as
    | boolean
    | { prefetchAll?: boolean; defaultStrategy?: string }
    | undefined;
  const opts = typeof prefetch === "object" ? prefetch : {};
  const experimental = (config?.experimental ?? {}) as { clientPrerender?: boolean };
  return {
    __PREFETCH_DISABLED__: JSON.stringify(prefetch === false || prefetch === undefined),
    // `undefined` when not configured (prefetch's init() falls back), as Astro's plugin writes it.
    __PREFETCH_PREFETCH_ALL__: JSON.stringify(opts.prefetchAll) ?? "undefined",
    __PREFETCH_DEFAULT_STRATEGY__: JSON.stringify(opts.defaultStrategy) ?? "undefined",
    __EXPERIMENTAL_CLIENT_PRERENDER__: JSON.stringify(!!experimental.clientPrerender),
  };
}

async function buildClient(
  o: AstroBuildOptions & {
    root: string;
    components: Map<string, CompiledComponent>;
    renderers: { clientEntrypoint?: string }[];
    clientAssets: ClientAssets;
    mounts: Map<string, Mount>;
  },
): Promise<ClientBuild> {
  const out: ClientBuild = { entryModules: {}, inlinedScripts: [] };
  const islands = [...new Set([...o.components.values()].flatMap((c) => c.islands ?? []))];
  const rendererEntries = [
    ...new Set(o.renderers.map((r) => r.clientEntrypoint).filter(Boolean)),
  ] as string[];
  const hash = async (b: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-1", b))]
      .slice(0, 5)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  const enc = new TextEncoder();
  const clientBundle = async (entrySource: string, name: string) => {
    const entry = `/.astro-in-browser-${name}.js`;
    await o.files.write(`${o.root}${entry}`, [enc.encode(entrySource)]);
    return bundle({
      esbuild: o.esbuild,
      sourcemap: false,
      files: o.files,
      root: o.root,
      entry,
      packages: o.trace ? tracedPackages(o.packages, o.trace) : o.packages,
      conditions: ["browser", "module", "import"],
      // Astro's client-side virtual modules (its Vite plugins define them): the view-transitions
      // router ClientRouter's script imports, and the adapter's fetch headers prefetch reads.
      modules: (spec) => CLIENT_MODULES[spec],
      define: {
        ...prefetchDefines(o.integration?.config),
        "process.env.NODE_ENV": '"production"',
        "import.meta.env": JSON.stringify({
          MODE: "production",
          DEV: false,
          PROD: true,
          SSR: false,
          BASE_URL: "/",
        }),
      },
      esbuildOptions: {
        minify: true,
        plugins: [
          pathsPlugin({
            root: o.root,
            packages: o.packages,
            nodeMounts: o.nodeMounts ?? new Map(),
            mounts: o.mounts,
            components: new Map(),
            clientAssets: o.clientAssets,
            builtin: () => undefined,
            trace: o.trace,
          }),
          vitePluginsAdapter(o.integration?.plugins ?? [], o.trace),
          astroPlugin({
            transform: o.transform,
            mounts: o.mounts,
            components: o.components,
            trace: o.trace,
          }),
        ],
      },
    });
  };
  if (islands.length || rendererEntries.length) {
    const src = [
      ...islands.map((s, i) => `export { default as i${i} } from ${JSON.stringify(s)};`),
      ...rendererEntries.map((s, i) => `export { default as r${i} } from ${JSON.stringify(s)};`),
    ].join("\n");
    const r = await bundleTimed(o, "client islands + renderers", () => clientBundle(src, "client"));
    await o.release?.(); // the largest client bundle (the admin's React app): its memory back
    const bytes = enc.encode(r.code);
    const shared = `/_astro/client.${await hash(bytes)}.js`;
    o.clientAssets.set(shared, bytes);
    const reexport = async (spec: string, name: string) => {
      const code = enc.encode(`export { ${name} as default } from ${JSON.stringify(shared)};\n`);
      const url = `/_astro/${name}.${await hash(code)}.js`;
      o.clientAssets.set(url, code);
      out.entryModules[spec] = url;
    };
    for (const [i, s] of islands.entries()) await reexport(s, `i${i}`);
    for (const [i, s] of rendererEntries.entries()) await reexport(s, `r${i}`);
  }
  // Scripts Astro's build always emits: the before-hydration hook and the page script, which
  // no integration here adds to (injectScript is not supported), so both are empty modules.
  const empty = enc.encode("export {};\n");
  const emptyUrl = `/_astro/empty.${await hash(empty)}.js`;
  o.clientAssets.set(emptyUrl, empty);
  out.entryModules["astro:scripts/before-hydration.js"] = emptyUrl;
  out.entryModules["astro:scripts/page.js"] = emptyUrl;
  let n = 0;
  for (const [id, c] of o.components)
    for (const [index] of (c.scripts ?? []).entries()) {
      const key = `${id}?astro&type=script&index=${index}&lang.ts`;
      // Best effort: scanned components no route uses may have scripts that do not bundle here.
      try {
        const r = await bundleTimed(o, `script ${key}`, () =>
          clientBundle(`import ${JSON.stringify(key)};\n`, `script-${n++}`),
        );
        out.inlinedScripts.push([key, r.code]);
      } catch (err) {
        // esbuild's message lists each error on a line of its own: keep them all.
        o.log?.(
          `skipped the script of ${id}: ${String((err as Error)?.message ?? err)
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 6)
            .join(" | ")}`,
        );
      }
    }
  return out;
}

const bundleTimed = <T>(o: AstroBuildOptions, what: string, fn: () => Promise<T>) =>
  o.trace ? o.trace.time("bundle", what, fn) : fn();

/** For each route's component, the styles of the `.astro` files it imports, transitively. */
function stylesByPage(
  metafile: { inputs: Record<string, { imports: { path: string }[] }> } | undefined,
  routes: RouteData[],
  components: Map<string, CompiledComponent>,
): Record<string, string[]> {
  const inputs = metafile?.inputs ?? {};
  const graph = new Map<string, string[]>();
  for (const [k, v] of Object.entries(inputs))
    graph.set(
      stripNs(k),
      v.imports.map((i) => stripNs(i.path)),
    );
  const out: Record<string, string[]> = {};
  for (const r of routes) {
    const start = `~/${r.component}`;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of graph.get(id) ?? []) stack.push(next);
    }
    out[r.component] = [...seen].flatMap((id) => components.get(id)?.css ?? []);
  }
  return out;
}

const stripNs = (p: string) => p.replace(/^[a-z-]+:(?=~|npm:)/, "");
