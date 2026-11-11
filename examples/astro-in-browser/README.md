# Astro built in a browser tab

`@statewalker/astro-in-browser-example`: an Astro SSR app built from its sources **inside a browser tab** and run there on CellB. Astro's
compiler and esbuild run as WebAssembly, packages come from the npm registry, and the built Worker
runs in CellB's shards with its Durable Objects on CellB's LTX storage. Two apps are built this way,
a small Astro app (`app/`) and [EmDash](https://github.com/emdash-cms/emdash)'s `blog-cloudflare`
template
(`../emdash`), which brings `astro.config.mjs`, its integrations, 225 routes, React islands, D1,
R2, KV and a cron trigger. The same builder runs on Node, and its output runs on CellB in Node too.
The package is private, since it is a test of CellB and of webrun-bundler and not a library.

**Live demo: <https://cellb-astro.httpeers.net>**: pick the small app or EmDash, and the tab
builds it and runs it. EmDash built ahead of time and served from static files:
<https://cellb-emdash.httpeers.net> ([emdash](../emdash/README.md)).

## How it fits together

```
host tab (browser/host.ts, emdash.html or index.html)
 ├─ ServiceWorker (browser/sw.ts): COOP/COEP headers (SharedArrayBuffer), routes the origin to the
 │    project's shards (installProjectRouter)
 ├─ package store: a Durable Object project on CellB (src/pkgstore/worker.js), on the LTX storage
 │    (bucket: { ltx: "pkgstore-ltx" }); packs in 256 KiB deflated blocks, served by range
 ├─ builder worker (browser/builder-worker.ts)
 │    ├─ download workers: fetch a package from the registry, pack it, PUT it to the store
 │    ├─ Astro's compiler (compiler-rs, WebAssembly, from npm)
 │    ├─ esbuild-wasm in a worker of its own, restarted after each large bundle
 │    └─ src/builder: astro.config.mjs and its integrations, routes, virtual modules, the server
 │       bundle (ONE Worker module) and the client bundles
 └─ site shard (browser/shard-worker.ts): the built Worker on CellB, its Durable Objects (D1, KV,
      R2 included) on the LTX storage (bucket: { ltx: "<app>-ltx" })
```

- **Packages** go through the package store by default. A missing package is downloaded once,
  and the build's lock (`/locks/<app>.json`) lets the next build prefetch every package from the
  store without downloading anything. `?memory` keeps them in the builder's memory instead, fetched
  from the
  registry on every build.
- **The project's own Worker entry.** When `wrangler.jsonc` names a `main` (EmDash's
  `src/worker.ts`, with `scheduled()` for its cron trigger and `PluginBridge`), it is the bundle's
  entry,
  with `@astrojs/cloudflare/entrypoints/server` and `astro/app/entrypoint` backed by the build's
  app.
- **Memory.** esbuild's WebAssembly memory grows during a bundle and is released only with its
  worker, so the builder restarts it after the server bundle and after the client bundles. When no
  output source map is asked for, webrun-bundler does not inline the packages' own maps, which
  takes EmDash's server bundle from 58.9 MB to 27.0 MB of input. The server bundle is minified, with
  names kept.
- **Cells on LTX files.** Each Durable Object is a SQLite database read page by page from its LTX
  files in OPFS through a store worker (CellB's `bucket: { ltx }`; see
  [Running in a browser](../../packages/cellb/docs/browser-host.md)).

## How to use it

`@statewalker/webrun-bundler` and CellB come from npm, like the other packages:

```
pnpm --dir .. install          # the examples' workspace (examples/)
pnpm dev:browser              # Vite; open http://localhost:<port>/__cellb/emdash.html (or /__cellb/)
pnpm test                     # the builder on Node: the small app, EmDash's config and build
pnpm test:browser             # every Playwright spec in test/browser (long; see below)
pnpm build:static             # the host pages as static files, in dist/static
pnpm serve:static             # python3 -m http.server on 127.0.0.1:8080
STATIC=1 pnpm exec playwright test test/browser/build-in-browser.spec.ts   # a spec on dist/static
```

The static build is what https://cellb-astro.httpeers.net serves: `/` links to the two host pages
(`/__cellb/` for the small app, `/__cellb/emdash.html` for EmDash), each app's sources are files
under `/__cellb/<app>-src/`, and the ServiceWorker is one file, `/cellb-sw.js`
(`browser/vite.sw.config.ts`). Both apps run at the origin's root, so building one replaces the
other.

`?memory` on the page keeps packages in memory; `?pools` puts the site's cells in CellB's OPFS
pools instead of the LTX storage. Network access to registry.npmjs.org is needed.

| Spec (`test/browser/`) | What it proves |
|---|---|
| `build-in-browser.spec.ts` | the small app is built in the tab (in about 5 s) and served by CellB |
| `emdash-in-browser.spec.ts` | EmDash is built in the tab through the package store (about 320 downloads cold, then none after a reload), run on the LTX storage and seeded; its pages and hydrated admin render, and it is exported as a ZIP and served from disk. `EMDASH_STORE=0` keeps packages in memory, and `EMDASH_HEAP=1` reports the memory of every realm. The spec fails on skipped component scripts, unsupported configuration and LTX store failures |
| `emdash-admin-in-browser.spec.ts` | on the build made in the tab, runs EmDash's setup wizard, creates a passkey account and publishes a post with a featured image in R2; reads the post back after a reload of the host tab (a new build); checks that a second host tab takes the shard over when the first closes |
| `pkgstore-probe.spec.ts` | the package store alone, then under concurrent 5–20 MB PUTs, ranged GETs and compaction, with an integrity pass (`PKGSTORE_PACKS=80 PKGSTORE_CONCURRENCY=8` goes past the context's storage, and then only PUTs may fail) |
| `cells-lab`, `*-probe` | a lab of the storage choices for shards, and probes (see each file's header). The labs of CellB's storage internals (`ltx-lab`, `sqlite-lab`) are in `packages/cellb/e2e-browser/probes` |

On Node: `npx tsx scripts/trace-build.mts emdash` builds EmDash with the builder and writes a trace
(`traces/emdash/`); `npx tsx scripts/run-node.mts` then runs that bundle on CellB in Node with D1,
R2 and KV, and checks that its cron trigger runs `scheduled()`.

## Measurements

On a 4-CPU machine with Chrome for Testing 153 (`emdash-in-browser.spec.ts`):

| | cold | warm |
|---|---|---|
| EmDash through the package store | ~115 s | ~65–78 s |
| EmDash, packages in memory | ~75 s | |

The renderer process peaks at about 2.0 GB, during the server bundle. Under a cgroup memory limit
on everything (Chromium, the Vite dev server, the test runner) the spec passes at 3 GB and the tab
crashes at 2.5 GB.

## What will surprise you

- **`Error processing $media https://images.unsplash.com/…`** appears without network access to
  Unsplash. The template's seed downloads its sample images, and the posts are created without
  them.
- **"Owner of cell shard 0 was lost"** is the answer to a request in flight when the tab running
  the shard closes. Another host tab takes the shard over, and a reload succeeds.
- **The first build in a fresh browser is the slow one**, because every package is downloaded and
  stored.
  Clearing the site's storage clears the package store too.
- **Sandboxed plugins are off**, as in the template (`worker_loaders` is commented out).
- **`Set siteUrl or EMDASH_SITE_URL before running production setup`** from EmDash's setup, on
  the static build only, means the built Worker saw no `vars` in `process.env`. A Vite production
  build rewrites `globalThis.process.env` to `{}`, which empties CellB's
  `Object.assign(globalThis.process.env, vars)` in the shard worker; `browser/vite.config.ts`
  defines it back to itself for `vite build` only (the dev server does not rewrite it, and its
  client evaluates every define in the host page and its workers, which have no `process` yet).
- **`Could not resolve "…": Failed to fetch`** in a cold build is a download from the npm
  registry that failed. Building again downloads only the packages still missing.

## License

MIT
