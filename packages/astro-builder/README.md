# @statewalker/astro-builder

An Astro SSR build that runs wherever esbuild-wasm runs: in a browser tab or worker, in a Durable
Object, under Node. It reads an Astro project from a
[`FilesApi`](https://www.npmjs.com/package/@statewalker/webrun-files). It takes `astro` and its
dependencies from a `PackageStore` (the npm registry on demand, or a cache) and compiles `.astro`
files with Astro's compiler. The output is **one Worker module** (`export default { fetch }`:
Astro's `App`, the route manifest, every page) plus the client assets. cellb runs that module the
same way in Node and in a browser.

The package is private for now. It moved out of
[`examples/astro-in-browser`](../../examples/astro-in-browser), which builds a small Astro app and
EmDash with it. It is not published because it depends on `@statewalker/webrun-bundler` 0.1.1
(`sourcemap: false`), which is not on npm yet.

## Why it exists

Astro's own build is Vite under Node. A site whose sources live in the browser or in a Durable
Object (a notebook site, a CMS a user edits in a tab) has no Node to run it. This package does the
part of Astro's build an on-demand (`output: "server"`) site with a fetch-style adapter needs, on
`webrun-bundler` and esbuild-wasm, with no file system other than a `FilesApi`.

## How to use

```ts
import { buildAstroApp, preloadVfs, runAstroConfig } from "@statewalker/astro-builder";
import { loadAstroCompiler } from "@statewalker/astro-builder/browser"; // browsers only
import { npmPackages } from "@statewalker/webrun-bundler";
import * as esbuild from "esbuild-wasm";

await esbuild.initialize({ wasmURL }); // browsers; Node needs nothing
const transform = await loadAstroCompiler(); // Node: `transform` of @astrojs/compiler-rs

const built = await buildAstroApp({
  esbuild,
  transform,
  files, // a FilesApi holding the project
  root: "/site", // the project's directory in `files` (src/pages, package.json, …)
  packages: npmPackages(),
});
// built.code: the Worker module; built.clientAssets: Map<URL path, bytes>; built.routes
```

Run the module on cellb (`loadNodeProject` in Node, a project shard in a browser) or on any
Workers runtime that accepts an ES module with `nodejs_compat`.

### A project with `astro.config.mjs` and integrations

Run the configuration step first and pass what it registered:

```ts
const { vfs, mounts } = await preloadVfs(files, "/site", packages, [["astro"], ["emdash"]]);
const integration = await runAstroConfig({ esbuild, files, root: "/site", packages, vfs, evaluate });
const built = await buildAstroApp({ esbuild, transform, files, root: "/site", packages,
  integration, nodeMounts: mounts, hostModules, inject, main: "src/worker.ts" });
```

`evaluate(code)` imports an ES module's source (a Blob URL in a browser, a `data:` URL under
Node). `hostModules`/`inject` are the runtime's modules and globals (cellb's
`cellbHostModule`/`CELLS_GLOBALS_MODULE` from `@statewalker/cellb/host-modules`). See
`examples/astro-in-browser/browser/builder-worker.ts` for the full browser wiring.

### Exports

| Export | What it does |
|---|---|
| `buildAstroApp(options)` | The build: routes, middleware, virtual modules, styles, server bundle, client bundles. Returns `{ code, routes, components, clientAssets, inputs, ms }` |
| `preloadVfs`, `runAstroConfig` | Astro's configuration step: evaluates `astro.config.mjs` and runs the integrations' `astro:config:setup` / `astro:config:done` hooks over a synchronous in-memory file system |
| `cachedSource`, `prefetch`, `packOf`, `openPack`, `lockOf`, `subtree`, `BUILD_TOOLING` | A persistent package cache over any `FilesApi`, and parallel prefetch from the last build's lock |
| `projectRoutes`, `routeFromPattern`, `sortRoutes` | Astro's routes of `src/pages` as serialized `RouteData` |
| `compileAstro`, `clientPartsOf`, `astroModule`, `buildTimeNodeModule` | Lower-level pieces: one `.astro` compile, Astro's virtual modules, Node built-ins for build-time code |
| `Trace`, `tracedPackages`, `resolutionTrace`, `inputsByPackage` | A step-by-step trace of a build |
| `/browser`: `loadAstroCompiler()` | Astro's compiler as WebAssembly (`@astrojs/compiler-binding-wasm32-wasi` from the npm registry), in a cross-origin isolated realm |

## Examples

`test/build.test.ts` builds a project held in a `MemFilesApi` and runs it on cellb in Node. The
project has a layout, a component with a scoped style, pages from a **live content collection**
(content as data, read at request time), an inline module script and an endpoint. The test checks
the rendered pages, the inlined style, a 404 from the page and the endpoint's JSON. It also checks
that `<script type="module" is:inline>` reaches the page unchanged, which is how a notebook page
carries its `define()` calls.

## Internals

- **One esbuild pass per bundle.** `.astro` files (the project's and the packages') are compiled
  in an esbuild plugin (`astro-plugin.ts`). Astro's virtual modules come from `astro-modules.ts`,
  and integrations' Vite plugins run through `vite-adapter.ts`. Package and project paths are
  resolved by `paths-plugin.ts`, the rest by webrun-bundler.
- **Styles are inlined per route.** Components' scoped and global styles, and imported `.css` with
  relative `@import`s inlined, are collected per component and attached to the routes whose pages
  import them.
- **The adapter is the runtime.** `@astrojs/cloudflare` (and `@astrojs/react`'s build side) are
  stubbed in the configuration step; the Worker module wraps Astro's `App` itself, or the
  project's own entry when `main` is given.

## What will surprise you

- **No prerendering.** Every route renders on request; a static export crawls the running site
  (`examples/astro-in-browser/browser/export-site.ts`).
- **Pages are `.astro`, endpoints `.ts`/`.js`.** `.md`/`.mdx` pages are not compiled, and
  `astro:content` supports live collections only (no build-time content layer).
- **`astro:assets` uses the no-op image service**: images are not optimized.
- **Astro's compiler in a browser needs cross-origin isolation** (COOP/COEP): its WebAssembly
  module imports shared memory.
- **Memory.** esbuild-wasm's memory grows during a bundle and is never returned; pass `release` to
  restart it between the server and client bundles. EmDash's build peaks at about 2 GB in a tab.
- **The versions are pinned together**: astro 7.4.4 and `@astrojs/compiler-rs` 0.5.2 (the wasm
  binding `loadAstroCompiler` fetches). The builder re-implements parts of Astro's build that
  Astro does not export, so a new Astro major release needs a port.

## License

MIT
