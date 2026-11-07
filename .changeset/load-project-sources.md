---
"@statewalker/cellb": minor
---

`loadProject` in browsers loads a project from its sources, with a `compile` option (#72):
`bundleCompiler` (new entry `@statewalker/cellb/bundle`: webrun-bundler on esbuild-wasm, one ES
module) or `siteCompiler` (`@statewalker/cellb/site`: modules compiled one by one and served from a
ServiceWorker; `siteHostOverPort` / `hostSitesForWorker` let a page host a worker's site). Without
`compile`, only `cellb build` folders load, as before. `@statewalker/webrun-bundler` is a new
optional peer dependency. Importing the `node:*` polyfills (`@statewalker/cellb/host-modules`) no
longer fails in a realm without `process`.
