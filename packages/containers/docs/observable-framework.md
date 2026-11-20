# Observable Framework in containers

[Observable Framework](https://observablehq.com/framework/) installs and builds sites in Lifo
containers, in Node and in Chromium, as [layers](layered-files.md): one build step with egress
installs Framework into a FilesApi, and site builds run on that layer, read-only, with no network.

Tested in `test/observable-framework.test.ts` (Node) and `e2e-browser/layers.spec.ts` (Chromium),
with the recipe in [`examples/observable-framework/recipe.ts`](../examples/observable-framework/recipe.ts).
Both need the npm registry and jsDelivr for the build step.

## The flow

```ts
import { frameworkBuild, frameworkBuildSteps, frameworkLayerFiles } from "./examples/observable-framework/recipe.ts";

// 1. the layer: package.json and the adaptation, then the build steps, in a container with egress
const layer = new MemFilesApi();
for (const [path, content] of Object.entries(frameworkLayerFiles("/data"))) await writeText(layer, `/${path}`, content);
const build = createIsolatedPool({ spawn: lifoWorkerWithEgress, image: { packages: [], enableInternet: true, env }, size: 1 });
for (const argv of frameworkBuildSteps("/data")) await build.run({ argv, files: layer, cwd: "/data" });
await build.close();

// 2. a site: its sources in a layer of its own, over the read-only base; no network
const site = new MemFilesApi();
await writeText(site, "/src/index.md", "# Hello\n");
await runs.run({ argv: frameworkBuild("/data"), files: cow(readOnly(layer), site), cwd: "/data" });
// site now holds dist/index.html and the rest of the built site; the base is unchanged
```

The build steps are `npm install`, `node prepare.mjs` (adapts the CLI, below) and one build of a
placeholder page that fills Framework's npm cache (`src/.observablehq/cache`), which is then
removed. Framework downloads its client's npm modules (`npm:d3`, `npm:@observablehq/plot`, ...)
during a build and resolves their versions from that cache first, so site builds need no network.
A site that imports a module the cache does not have fails without network (tested): add it to
the placeholder page, or give that build egress.

| | Node 24 | Chromium |
| --- | --- | --- |
| `npm install` (260 packages, into the layer's FilesApi) | 7.3 s | 8.5 s |
| adapting the CLI | 1.4 s | 5.8 s |
| filling the npm cache (a placeholder build) | 4.9 s | 6.0 s |
| a site build without network | ~5.0 s | ~6.2 s |

## Adapting Framework to Lifo

Framework 1.13.4's CLI does not run in Lifo as published. `prepare.mjs` bundles it with esbuild
into `dist/observable.lifo.mjs`, working around:

- **Lifo's ESM loader** mis-parses some dependencies (a comment inside an export list in
  `get-east-asian-width`): the bundle avoids the loader.
- **Missing built-ins:** `node:path/posix` (Lifo's `path` is POSIX already),
  `node:timers/promises`, `util.parseArgs` (from `@pkgjs/parseargs`) and `util.deprecate`: shims.
- **Packages that find files next to themselves** stay outside the bundle: `jsdom` (its XHR worker
  script), `esbuild` (Lifo's own) and `rollup` (as `@rollup/wasm-node`: Lifo cannot load native
  addons). `css-tree` reads `../data/patch.json` relative to its file, now the bundle: the file is
  copied next to it.
- **Lifo's esbuild** resolves every import through its own VFS plugin: it ignores `external`, and
  resolves a cwd-relative alias as a package. A wrapper turns Framework's style aliases into a
  plugin. In browsers it is esbuild-wasm, which has no filesystem to fall back on: an import Lifo
  cannot resolve fails the build (debug's optional `supports-color` is kept external).
- **Lifo's `import()`** keeps a query string in the path, and Framework imports its config file
  with a cache-busting query: no `observablehq.config.js`; the defaults apply (`root: "src"`).

## Preview

`observable preview` starts and serves pages through the container's port
(`container.getTcpPort(3000).fetch()`), checked in Node by hand: the page and `client.js` answer
200 and keep answering. Live reload does not work: Framework's `WebSocketServer` is not available
in Lifo. Not covered by a test.

## In Wasmer (edgejs): blocked

`wasmer/edgejs` installs Framework (in about 37 s, with `node-linker=hoisted` and esbuild/rollup replaced by
their wasm builds) but cannot run it: edgejs does not keep live bindings across cyclic ES module
imports (a module sees `undefined` for a function exported by a module that imports it back;
reproduced with two plain modules), and Framework's sources have such cycles. Bundling the CLI
inside edgejs with esbuild-wasm crashed the Wasmer worker (`WORKER_FAILED`). Both are upstream
issues.
