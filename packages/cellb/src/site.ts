// @statewalker/cellb/site: a project's sources compiled and served in the browser (an in-browser
// HTTP server for `browserProjectRuntime({ site })`, or `loadProject`'s `compile: siteCompiler()`).
// It needs the optional peer dependencies @statewalker/webrun-modules,
// @statewalker/webrun-site-builder and @statewalker/webrun-site-host (the ServiceWorker host).
export { createProjectSite } from "./project/site.js";
export {
  type HostedProjectSite,
  hostSitesForWorker,
  type SiteCompilerOptions,
  type SiteControl,
  type SiteHost,
  siteCompiler,
  siteHostOverPort,
} from "./project/site-compiler.js";
export type { CompiledProject, ProjectCompiler } from "./project/source-project.js";
