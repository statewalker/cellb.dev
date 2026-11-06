// @statewalker/cellb/site: a project's sources compiled and served in the browser (an in-browser
// HTTP server for `browserProjectRuntime({ site })`). It needs the optional peer dependencies
// @statewalker/webrun-modules and @statewalker/webrun-site-builder; the embedder hosts the site in
// a ServiceWorker with @statewalker/webrun-site-host, the third optional peer.
export { createProjectSite } from "./project/site.js";
