# @statewalker/cellb-platform

> Private, not published. The webrun apps as Durable Object applications, composed into one
> Worker, with their per-host builds and end-to-end checks. The apps themselves are the packages
> next to this one:
>
> | Package | What it holds |
> |---|---|
> | [`platform-core`](../platform-core) | FilesApi on Durable Object SQLite, the package store, ZIP/JSONC, the WebAssembly the entry provides, peer resolution |
> | [`esm-cdn`](../esm-cdn) | the ESM CDN and user code as ESM |
> | [`bundler`](../bundler) | the bundler, its job object and the Node runner (`bin/webrun-build.ts`) |
> | [`astro-builder`](../astro-builder) | Astro projects built from their sources (the port of examples/astro-in-browser's builder) |
> | [`notebooks`](../notebooks) | notebooks compiled to pages |

## What it is

Five apps, each a set of Durable Objects with a `wrangler.jsonc`, composed into one Worker. The
same build runs on Wrangler (workerd, as on Cloudflare), celld 0.6.3, cellb in Node, and cellb in
a browser tab:

| App | Routes | Durable Object | Built on |
|---|---|---|---|
| Package store | `/registry/<name>` | `PackageRegistry`, one per package | a caching proxy of the npm registry |
| ESM CDN | `/npm/<browser\|node>/<name>[@range][/sub]` | `ModuleHost`, one per profile | `@statewalker/webrun-modules` |
| User code as ESM | `/p/<project>/…` | `Project`, one per project | `@statewalker/webrun-modules` |
| Bundler | `/builds`, `/b/<build>/…` | `BuildJob`, one per build | `@statewalker/webrun-bundler` on esbuild-wasm |
| Notebooks | `/nb/<site>/…` | `NotebookSite`, one per site | `@statewalker/notebook-build`, `@statewalker/notebook-site` |

- **The package store** backs every other app. It caches each npm packument for 10 minutes and
  each tarball forever, in the object's SQLite. The other apps reach it through webrun-modules'
  `npmRegistrySource({ fetch })`, and the Node runner reaches it over HTTP.
- **The ESM CDN** serves npm packages as ESM. A range redirects to a pinned URL, and pinned URLs
  are immutable. `?graph` lists every module an entry needs; `?meta` lists a package's files. CSS
  goes through Lightning CSS.
- **User code as ESM** serves a project's files as ESM. A project is files with entry points. A
  snapshot is the hash of the tree, so a snapshot's transformed modules never go stale. TS, TSX,
  JSX and CommonJS are transformed one module at a time, CSS is served as `?module`, and bare
  imports bind to the CDN's pinned URLs at the project's `package.json` ranges.
- **The bundler** turns a project into one package. The input is a ZIP, JSON, or a project
  snapshot. The output is a `no_bundle` wrangler project (`wrangler.json`, `worker.js` with its
  source map, `assets/`, D1 migrations), as files, as `project.zip`, and as a Worker Loader
  payload (`loader.json`). Small builds run in the object. Large ones wait for the Node runner
  (`packages/bundler/bin/webrun-build.ts`), which uses the same `buildProject`.
- **Astro builds from sources**: a project with an `astro.config.*` (or `kind: "astro"`) is
  built by a port of the in-browser Astro builder of `examples/astro-in-browser` (`packages/astro-builder`), then bundled like any
  Worker. It works in the object, on the Node runner, and in a browser tab; see
  [Astro builds](#astro-builds).
- **Notebooks** compiles Markdown notebooks and Observable Notebook Kit HTML documents to pages
  inside the object. A page's npm imports come from the site's module server.

## Why it exists

The plan was to turn three webrun functions into Durable Object apps that run on every host the
statewalker stack targets: the ESM CDN, user code as ESM, and the bundler. This package is that
prototype, in one place, with demos that prove it on small apps and on EmDash.

## How to use it

Node 22.23 or later (the repository's `.nvmrc`: Node 24), and pnpm, from the repository root
(`pnpm install`). In this repository cellb's entry points are its TypeScript sources, so the scripts
that load cellb on Node run through `tsx`.

```sh
cd packages/platform
pnpm run build                    # dist/platform/workerd (Wrangler, celld) and dist/platform/cellb
npx wrangler dev                  # the sources, on workerd
npx wrangler dev -c dist/platform/workerd/wrangler.json
scripts/get-celld.sh && (cd dist/platform/workerd && celld dev .)   # celld bundles with esbuild: put node_modules/.bin on PATH
npx tsx scripts/serve-cellb.mjs dist/platform/cellb --port 8793     # cellb in Node
pnpm run build:browser && python3 -m http.server -d dist/browser 8080 # cellb in a tab: open /__cellb/
```

Then, against any of them:

```sh
curl -L localhost:8787/npm/browser/react                         # the ESM CDN
curl 'localhost:8787/npm/browser/react-dom@19/client?graph'
(cd fixtures/react-page && zip -r - .) | curl -X POST --data-binary @- localhost:8787/p/demo/import
curl -X POST localhost:8787/p/demo/snapshots                     # → { base }: open <base>~/index.html
(cd fixtures/hello-worker && zip -r - .) | curl -X POST --data-binary @- localhost:8787/builds
curl -o build.zip localhost:8787/b/<id>/project.zip              # unzip; wrangler dev / celld dev / cellb
npx tsx ../bundler/bin/webrun-build.ts --runner http://localhost:8787   # the Node tier, for queued builds
```

## Examples

### What is checked, and where

`scripts/e2e.ts [wrangler|celld|cellb|all]` starts the platform on each host and checks:

- the CDN, on a small graph (react-dom) and a large one (Observable Plot with d3);
- `fixtures/react-page` (TSX, CSS, React from the CDN) served as ESM and rendered in Chromium;
- `fixtures/hello-worker` (Hono, a Durable Object, assets) built in the object and run on the
  same host;
- the same project built by the Node runner.

`scripts/e2e-browser.ts` checks the platform in a Chromium tab on cellb: CDN, project page,
bundler (esbuild-wasm in the tab), notebooks, the Astro demo built from its sources in the
tab, then run on cellb in Node with its island hydrated, and the notebooks' Astro theme built in
the tab and rendering the notebooks there.

`examples/platform-demos` (in the examples' workspace) has whole apps; see
[its README](../../examples/platform-demos/README.md):

- Astro (SSR, a React island, a Durable Object);
- EmDash (Astro CMS: D1, KV, R2, cron);
- notebooks (Markdown and Observable Notebook Kit).

Each demo is built and run on every host.

### Results on this prototype

| | Wrangler | celld | cellb Node | cellb in Chromium |
|---|---|---|---|---|
| ESM CDN (react-dom, Observable Plot) | yes | yes | yes | yes |
| User code as ESM (React page renders) | yes | yes | yes | yes |
| Bundler in the object (hello-worker) | yes | yes | yes | yes |
| Built Worker runs on the host | yes | yes | yes | n/a |
| Bundler on the Node runner | yes | yes | yes | n/a |
| Astro demo: bundled, SSR, Durable Object, island | yes | yes | yes | n/a |
| EmDash: bundled (runner), setup seeds D1, pages | yes | yes | yes | n/a |
| EmDash bundled inside the object (38.5 MB input) | 29 s | 10 s with `CELLD_V8_HEAP_LIMIT_MB=2048` | 16 s | n/a |
| Notebooks compiled in the object, cells run | yes | yes | yes | yes |
| Notebooks rendered by an Astro theme built in the object (page models, Worker Loader), cells run | yes | yes | yes | yes (theme built in the tab) |
| Themed notebook site exported as static files, its cells run from a file server | yes | yes | yes | exported in the tab |
| Astro demo built from its sources in the object, then run and hydrated | yes (Worker Loader) | yes (Worker Loader) | yes | yes (built in the tab, run on cellb) |
| EmDash built from its sources on the Node runner (225 routes), setup seeds D1 | yes | yes | yes | n/a |
| EmDash built from its sources in the object | 146 s (Worker Loader) | 102 s (Worker Loader, `CELLD_V8_HEAP_LIMIT_MB=4096`) | 87 s | not tried |

## Internals

### One build per host

`scripts/build.mjs` bundles an entry (`src/entries/platform.ts`, `cdn.ts` or `bundler.ts`) twice:

- `dist/<name>/workerd/` keeps the `.wasm` imports as WebAssembly modules next to `worker.js`
  (`no_bundle`). workerd and celld forbid compiling WebAssembly from bytes at run time.
- `dist/<name>/cellb/` compiles the WebAssembly from bytes embedded in the bundle, because cellb's
  project bundler has no `.wasm` loader.

Both alias `cjs-module-lexer` to its pure-JS build: its ESM build compiles inline WebAssembly,
which workerd refuses.

The entry hands the WebAssembly modules to `platform-core/src/wasm.ts`:

- esbuild-wasm is initialized with `{ wasmModule, worker: false }`;
- lightningcss-wasm is initialized before webrun-modules calls its `init()`, so it never fetches
  a `.wasm` by URL.

### Storage

`platform-core/src/sql-files.ts` is a FilesApi on the object's `ctx.storage.sql`:

- blocks of at most 256 KiB, to stay under Cloudflare's 2 MB value limit;
- range queries, not `LIKE`, because workerd limits LIKE pattern length;
- one table prefix per FilesApi.

Every app keeps its files there: packuments and tarballs, transformed modules, project snapshots,
build inputs and outputs, notebook sources and pages.

### One build that runs everywhere

`bundler/src/build.ts` bundles `main` with webrun-bundler:

- conditions `workerd, worker, browser`;
- `cloudflare:*` and `node:*` left to the runtime;
- with nodejs_compat, the bare Node built-in names too.

It also makes the output portable across hosts:

- **KV namespaces without an `id`** (Astro's adapter adds `SESSION` so) get a stable one. celld
  requires it.
- **`node:module`** is replaced by a shim whose `createRequire` falls back to a `require` of the
  common built-ins. celld 0.6.3 throws "not implemented" from `createRequire`, which EmDash calls
  at module initialization.
- **A host-compatibility entry** (`bundler/src/compat.ts`) wraps the default handler. It patches
  the D1 bindings so that a table-valued pragma on celld's internal tables (`_litestream_lock`)
  answers no rows instead of "not authorized". Kysely's SQLite introspector reads every table
  `sqlite_master` lists, so EmDash's migrations fail on celld without it.

### Placement of builds

- A build whose inputs exceed `IN_OBJECT_BUILD_MAX_BYTES` (8 MB), or one asked with
  `tier=runner`, is queued.
- `bundler/bin/webrun-build.ts --runner <origin>` claims it (`POST /builds/claim`), downloads the inputs,
  builds with native esbuild, and uploads the output.
- A Cloudflare isolate has 128 MB, and EmDash's build needs far more. The EmDash row of the
  results table shows the in-object build works on hosts without that limit.
- ZIP downloads are streamed one file at a time. celld's isolate heap (about 430 MB by default)
  cannot hold a 38 MB archive and its files together.

### Astro builds

`packages/astro-builder` is `examples/astro-in-browser/src/builder`, ported. It does what Astro's
build does for an on-demand (`output: "server"`) site, without Vite:

- routes come from `src/pages` and from the integrations;
- `astro.config.mjs` is bundled and evaluated, and its integrations' hooks run (EmDash's
  included, with its Vite plugin's virtual modules);
- `.astro` files are compiled with compiler-rs;
- the server bundle is one Worker module, and the client bundles hold the islands, the renderers
  and the component scripts.

`astro-builder/src/project.ts` writes what Astro's Cloudflare build writes (`wrangler.json`,
`server/entry.mjs`, `client/`). `bundler/src/any.ts` then sends that through `buildProject`, so
an Astro build gets the same host compatibility as any Worker.

What changed from the original:

- **It builds for every host, not only cellb's browser realm.** `cloudflare:*` and `node:*`
  stay imports, so the output runs on workerd, celld and cellb alike.
- **Where the project's config is evaluated.** The config is project code and npm packages, and
  workerd and celld refuse to evaluate code: no `import("data:…")`, no `new Function`, no Blob
  URLs. There, `astro-builder/src/loader.ts` runs the whole Astro build in a Worker Loader isolate:
  - the config is bundled in the object;
  - the builder (`astro-builder/src/loaded-builder.ts`, bundled by `scripts/build.mjs` and embedded in
    the platform), the config, `esbuild.wasm` and the compiler are loaded as the modules of a
    Worker, so the config is imported statically, in an isolate of its own.

  cellb and browsers evaluate the config in the object's own realm with a data: URL import.
- **Where the compiler comes from.** Astro's compiler is the wasm32-wasi build of compiler-rs,
  which needs a shared WebAssembly memory. workerd, celld and cellb on Node provide one; a
  browser tab must be cross-origin isolated, so `browser/sw.ts` adds COOP/COEP.
  - It comes from the package store at run time, so the platform does not carry its 6 MB.
  - The Node runner uses the native `@astrojs/compiler-rs`.
- **Islands imported from the project itself now resolve.** compiler-rs's own `transform`
  rewrites the islands' `client:component-path` with `resolvePath` after the binding returns. The
  original's WebAssembly loader called the binding alone, so a project's island
  (`../components/Counter.tsx`) failed at render with "Unable to resolve". `compiler.ts` now
  does that step too.
- **One React.** Peer dependencies take the project's version, as npm installs them
  (`platform-core/src/peers.ts`). Otherwise `@astrojs/react`'s peer range picked a newer React than
  the project's, and hooks failed with "Invalid hook call".
- **JSX and `process.env.NODE_ENV` as Astro's Vite build sets them.**
  - JSX uses the automatic runtime of the renderer's package.
  - Production React is bundled; its development build calls `console.createTask()`, which
    celld lacks.
- **A catch-all route ranks after `/`.** A rest route (`/[...rest]`) sorts after every route
  without one, as in Astro. Before, it caught `/`.
- **Build-time packages are a spec option, not EmDash's hard-coded list.**
  `spec.astro.preload` names the packages integrations read from disk, and `spec.astro.metaUrl`
  sets `import.meta.url` for the config bundle. EmDash's are in `examples/platform-demos/scripts/e2e.ts`
  (`EMDASH_SPEC`).

```sh
(cd ../../examples/platform-astro && zip -r - . -x 'node_modules/*' 'dist/*') | curl -X POST --data-binary @- localhost:8787/builds
npx tsx ../bundler/bin/webrun-build.ts ../../examples/emdash --out /tmp/emdash \
  --spec '{"astro":{"preload":[["emdash"],["@emdash-cms/admin","emdash"]],"metaUrl":"file:///node_modules/emdash/dist/astro/index.mjs"}}'
```

### Size

The workerd folders, gzipped:

- the composed platform: 8.5 MB, under Cloudflare's 10 MB limit for paid plans (Astro's
  compiler is not in it, see [Astro builds](#astro-builds));
- `src/entries/cdn.ts` (no esbuild): 4.4 MB;
- `src/entries/bundler.ts` (no lightningcss): 4.6 MB.

Build each with its config in `deploy/`.

## What will surprise you

- **Without `PLATFORM_TOKEN` the platform is open.** Anyone who can reach it can write projects,
  run builds and fill its storage, and CORS allows every origin. That is for local development.
  Before deploying it anywhere reachable, set `PLATFORM_TOKEN` (a secret: `wrangler secret put
  PLATFORM_TOKEN`). Every request that writes or computes, and the runner's `input.zip`, then
  needs `Authorization: Bearer <token>`. The runner sends it from `WEBRUN_PLATFORM_TOKEN`. Reads
  (the CDN, snapshots, build outputs, notebook pages) stay public.
- **An Astro project's config is the project's code.** On CellB and in browsers it runs in the
  bundler's object, with that object's bindings in reach. On workerd and celld it runs in a
  Worker Loader isolate of its own. Build only projects you trust on a CellB host.

- **The apps call each other through Durable Object stubs within one script.** cellb and celld
  support no service bindings to other scripts. Split deployments (`deploy/*.jsonc`) contain
  every object they use.
- **celld's isolate heap is the limit for large builds there.** Raise it with
  `CELLD_V8_HEAP_LIMIT_MB`, or leave them to the runner.
- **The Chromium checks take `PW_CHROMIUM`, as cellb's own suites do.** The repository's
  Playwright may expect a browser build that is not installed: point `PW_CHROMIUM` at a Chromium
  binary. Where outbound HTTPS has a proxy (`HTTPS_PROXY`), Chromium gets it too, since the pages
  fetch from registry.npmjs.org (`scripts/chromium.ts`).
- **This package uses cellb from the workspace, not from npm.** The platform is checked against
  cellb as it is in this checkout; the examples use the released one.
- **An Astro build in a browser tab needs cross-origin isolation.** The host page reloads once
  so the ServiceWorker can add COOP/COEP. Without them, the other apps work and Astro builds
  fail with a message about the shared memory.
- **Astro builds do not prerender, and support what the integrations' hooks use.**
  `injectScript` and client directives of integrations are ignored, as in the original. Image
  services are replaced by the no-op one.
- **`sourcemap` is on by default.** EmDash's `worker.js.map` is larger than the worker. Pass
  `?sourcemap=0` to skip it.
- **Projects share the CDN's modules but not its `default` export analysis.** A project's
  `~deps` proxy for a CDN URL emits `default` only when the importer asks for it (a
  webrun-modules `cdn` binding).

## Reference

| Script | What it does |
|---|---|
| `pnpm run build` | `scripts/build.mjs`: dist/platform/{workerd,cellb} |
| `pnpm run build:browser` | `scripts/build-browser.mjs`: dist/browser, the platform in a tab on cellb |
| `scripts/e2e.ts [host\|all]` | the platform's checks on Wrangler, celld, cellb |
| `scripts/e2e-browser.ts` | the platform in Chromium on cellb |
| `tsx scripts/serve-cellb.mjs <dir>` | a wrangler project on cellb in Node over HTTP |
| `scripts/hosts.mjs` | start/stop a project on any host (used by the e2e scripts) |
| `scripts/get-celld.sh` | downloads celld 0.6.3 to ~/.cache/celld |
| `../bundler/bin/webrun-build.ts` | the bundler's Node tier: a local build (Astro projects included), or `--runner <origin>` |
| `../astro-builder/scripts/fetch-astro-compiler.mjs` | downloads Astro's compiler as WebAssembly to vendor/, for the tests |

| Variable | Default | Meaning |
|---|---|---|
| `PACKUMENT_TTL_S` | 600 | how long a packument is fresh |
| `REGISTRY_URL` | registry.npmjs.org | the upstream registry |
| `IN_OBJECT_BUILD_MAX_BYTES` | 8000000 | larger builds go to the Node runner |
