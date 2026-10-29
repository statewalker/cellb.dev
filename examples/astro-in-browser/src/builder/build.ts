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
import { type AstroTransform, astroPlugin, type CompiledComponent } from "./astro-plugin.js";
import { projectRoutes, type RouteData } from "./routes.js";

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
}

export interface AstroBuildResult {
  /** The Worker module (ES module, `export default { fetch }`). */
  code: string;
  routes: RouteData[];
  /** Compiled components by file id, with their styles. */
  components: Map<string, CompiledComponent>;
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
  const routes = await projectRoutes(opts.files, root);
  log(`${routes.length} routes: ${routes.map((r) => r.route).join(", ")}`);
  const middleware = (await exists(opts.files, `${root}/src/middleware.ts`))
    ? "./src/middleware.ts"
    : (await exists(opts.files, `${root}/src/middleware.js`))
      ? "./src/middleware.js"
      : undefined;

  const mounts = new Map<string, Mount>([["~", { prefix: "~", files: opts.files, root }]]);
  const components = new Map<string, CompiledComponent>();

  // The manifest, with each route's styles filled in at runtime from the compiled components
  // the route's page imports (the bundle knows them only once it is built).
  const pages = routes.map(
    (r, i) =>
      `  [${JSON.stringify(r.component)}, () => import(${JSON.stringify(`./${r.component}`)}).then((m) => ({ page: () => m }))], // ${i}`,
  );
  const entry = `
import { App } from "astro/app";
import { deserializeManifest } from "astro/app/manifest";
import { DefaultFetchHandler } from "astro/app/fetch/default-handler";
import { routeStyles } from "virtual:astro-in-browser/styles";

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
  image: {}, devToolbar: { enabled: false, debugInfoOutput: "" }, logLevel: "info", shouldInjectCspMetaTags: false,
};
const pageMap = new Map([
${pages.join("\n")}
]);
const manifest = Object.assign(deserializeManifest(serialized), {
  renderers: [],
  pageMap,
  actions: async () => ({ server: {} }),
  middleware: ${middleware ? `() => import(${JSON.stringify(middleware)})` : `async () => ({ onRequest: (_ctx, next) => next() })`},
  serverIslandMappings: async () => ({ serverIslandMap: new Map(), serverIslandNameMap: new Map() }),
});
const app = new App(manifest);
app.setFetchHandler(new DefaultFetchHandler());

export default {
  async fetch(request, env, ctx) {
    return app.render(request, { locals: { runtime: { env, ctx } } });
  },
};
`;
  const styles = () => {
    // Every compiled component's styles, keyed by the page that imports it (transitively):
    // the metafile says which inputs each page pulled in.
    return `const byPage = ${JSON.stringify(pageStyles)};\nexport const routeStyles = (c) => (byPage[c] ?? []).map((content) => ({ type: "inline", content }));`;
  };
  let pageStyles: Record<string, string[]> = {};

  const run = () =>
    bundle({
      esbuild: opts.esbuild,
      files: opts.files,
      root,
      entry: "/.astro-in-browser-entry.js",
      packages: recording(opts.packages, mounts),
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
      modules: (spec) =>
        spec === "virtual:astro-in-browser/entry"
          ? entry
          : spec === "virtual:astro-in-browser/styles"
            ? styles()
            : spec === "astro:middleware"
              ? `export * from "astro/virtual-modules/middleware.js";`
              : undefined,
      lowerAwait: false,
      esbuildOptions: {
        plugins: [astroPlugin({ transform: opts.transform, mounts, components })],
        loader: { ".css": "empty" },
      },
    });

  // The entry is a host module, not a file: give the bundler a file that imports it.
  await opts.files.write(`${root}/.astro-in-browser-entry.js`, [
    new TextEncoder().encode(`export { default } from "virtual:astro-in-browser/entry";\n`),
  ]);
  log("bundling (pass 1: compile and collect styles)");
  const first = await run();
  pageStyles = stylesByPage(first.metafile, routes, components);
  log("bundling (pass 2: with the routes' styles)");
  const result = await run();
  return {
    code: result.code,
    routes,
    components,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
    ms: Date.now() - started,
  };
}

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
