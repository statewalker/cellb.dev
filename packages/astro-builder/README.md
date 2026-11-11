# @statewalker/cellb-astro-builder

> Private, not published. Used by [`bundler`](../bundler) for projects with an `astro.config.*`.

## What it is

[`examples/astro-in-browser`](../../examples/astro-in-browser)'s builder, ported into a package.
It turns an Astro project's sources into what Astro's Cloudflare build writes, without Vite or
Node:

- `wrangler.json`, with `main` → `server/entry.mjs` and `assets` → `client`;
- `server/entry.mjs`: one Worker module with Astro's `App`, the routes and every page;
- `client/`: `public/` and the client bundles.

It runs wherever esbuild runs: in a Durable Object, in a Worker Loader isolate, in a browser
worker, on Node.

## Use cases

- **Astro sites built by the platform from their sources.** A small app takes about 6 seconds in
  the bundler's object. EmDash (225 routes) takes about 35 seconds on the Node runner. Inside the
  bundler's object, on hosts without the 128 MB limit, it took 87 s on CellB in Node, 102 s on
  celld and 146 s on Wrangler ([the platform's results](../platform/README.md#results-on-each-host)).
- **Astro in a browser tab.** The platform's tab builds an Astro app from its sources. The result
  runs on CellB, and its islands hydrate.

## API

| Export | What it does |
|---|---|
| `buildAstroProject({ files, esbuild, transform, packages, spec?, log?, configModule? })` (`./project`) | sources → `{ files, routes, ms }` (the files above) |
| `isAstroProject(files)` | whether the project has an `astro.config.*` |
| `astroInLoader({ loader, files, esbuild, packages, registryFetch, spec?, log? })` (`./loader`) | the same build, in a Worker Loader isolate |
| `canEvaluate()` | whether this realm can evaluate a module from a string |
| `loadAstroCompiler(wasm)`, `astroCompilerFromRegistry(fetch?)` (`./compiler`) | compiler-rs as WebAssembly: from a module or bytes, or from the package store |
| `buildAstroApp(…)` (`./build`) | the builder's core: routes, manifest, server and client bundles |
| `bundleAstroConfig(…)`, `runAstroConfig(…)` (`./integrations`) | the config bundled for a realm; its integrations' hooks run |

`AstroSpec` fields:

| Field | Meaning |
|---|---|
| `preload` | packages build-time code reads from disk, `[name, importer?][]`. EmDash's is `[["emdash"], ["@emdash-cms/admin", "emdash"]]` |
| `metaUrl` | `import.meta.url` of the bundled config |
| `session` | Astro's session driver (default: Cloudflare KV on `SESSION`, as the adapter's) |

## How it works

- **The config runs first.** `astro.config.mjs` is bundled with Vite and Cloudflare tooling
  stubbed, and with Node modules over a synchronous virtual file system of the preloaded
  packages. It is then evaluated, and its integrations' `astro:config:setup` and
  `astro:config:done` hooks register:
  - routes and middleware;
  - Vite plugins, whose `resolveId`/`load` run inside esbuild;
  - renderers.
- **Where the config is evaluated.** workerd and celld refuse to evaluate code: no
  `import("data:…")`, no `new Function`, no Blob URLs. There, `astroInLoader` runs the whole build
  in a Worker Loader isolate:
  - the builder (`./loaded-builder`, bundled and embedded by the platform's build), the bundled
    config, `esbuild.wasm` and the compiler are its modules;
  - the project's build-time code is imported statically, in an isolate of its own.

  CellB and browsers evaluate the config with a data: URL import.
- **`.astro` with compiler-rs.** The compiler is its wasm32-wasi build, which needs a shared
  WebAssembly memory. A browser tab must be cross-origin isolated (COOP/COEP). The native build is
  used on Node. The compiler's `resolvePath` step, after the binding returns, is applied as
  compiler-rs's own `transform` does, so a project's own island resolves at render.
- **Bundles as Astro's Vite build makes them:**
  - production `process.env.NODE_ENV`, so React's production build is bundled;
  - the renderer's automatic JSX runtime;
  - one React for the server and the islands, since peer dependencies take the project's
    version.
- **Routes as Astro ranks them.** Static before dynamic, and a rest route (`/[...rest]`) after
  every route without one.

It differs from the example in two ways. It builds for workerd, celld and CellB, not only for
CellB's browser realm. And it fixes the island resolution, the JSX runtime, the production React
build and the route order.

```sh
pnpm --filter @statewalker/cellb-astro-builder test   # the WebAssembly compiler against the native one, routes
```
