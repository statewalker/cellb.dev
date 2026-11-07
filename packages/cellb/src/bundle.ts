// @statewalker/cellb/bundle: a project's sources bundled in the browser, for `loadProject`'s
// `compile`. It needs the optional peer dependency @statewalker/webrun-bundler, and esbuild-wasm,
// which the caller initializes and passes in (its .wasm URL is the app's to serve).
export { type BundleCompilerOptions, bundleCompiler } from "./project/bundle-compiler.js";
export type { CompiledProject, ProjectCompiler } from "./project/source-project.js";
