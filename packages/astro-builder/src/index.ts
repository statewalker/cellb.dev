// @statewalker/astro-builder: an Astro SSR build that runs wherever esbuild-wasm does.
// The browser-only loader of Astro's WebAssembly compiler is `@statewalker/astro-builder/browser`.

export { astroModule } from "./astro-modules.js";
export {
  type AstroTransform,
  type CompiledComponent,
  clientPartsOf,
  compileAstro,
} from "./astro-plugin.js";
export { type AstroBuildOptions, type AstroBuildResult, buildAstroApp } from "./build.js";
export {
  type InjectedRoute,
  type IntegrationResult,
  preloadVfs,
  runAstroConfig,
  type VitePluginLike,
} from "./integrations.js";
export { buildTimeNodeModule, VFS_GLOBAL } from "./node-shims.js";
export {
  BUILD_TOOLING,
  type CachedSource,
  cachedSource,
  type Downloader,
  lockOf,
  openPack,
  type PrefetchOptions,
  packOf,
  prefetch,
  type Source,
  subtree,
} from "./package-cache.js";
export type { ClientAssets } from "./paths-plugin.js";
export {
  projectRoutes,
  type RouteData,
  routeFromPattern,
  type Segment,
  sortRoutes,
} from "./routes.js";
export {
  inputsByPackage,
  resolutionTrace,
  Trace,
  type TraceEvent,
  type TraceStep,
} from "./trace.js";
export { tracedPackages } from "./traced-packages.js";
