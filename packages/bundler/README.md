# @statewalker/cellb-bundler

> Private, not published. Composed by [`platform`](../platform), whose README covers running it.

## What it is

The bundler turns a project into one package that Wrangler (`no_bundle`), celld and CellB run as
they get it. It uses [`@statewalker/webrun-bundler`](https://www.npmjs.com/package/@statewalker/webrun-bundler)
on esbuild-wasm, in a Durable Object (`BuildJob`), or on a Node runner for builds too large for an
isolate. A project with an `astro.config.*` is first built from its sources by
[`astro-builder`](../astro-builder).

## Use cases

- **A download:** a project's sources in, `project.zip` out, ready for `wrangler dev`,
  `celld dev` or CellB's `loadProject`.
- **Run-time code:** a Worker Loader payload (`loader.json`) that a host object loads by build id
  (`env.LOADER.get(id, …)`), with no redeploy.
- **Builds in a browser:** in the platform's tab, a build runs with esbuild-wasm in the shard
  worker, with nothing installed.

## API

### HTTP (`handleBuilds`, `BuildJob`)

| Request | Answer |
|---|---|
| `POST /builds` | a ZIP, or JSON `{ files, spec }`; or `?project=<id>&snapshot=<snap>` (a project of the ESM CDN app). A spec in the `x-build-spec` header. `?tier=object\|runner`, `?entry=`, `?minify=1`, `?sourcemap=0`, `?kind=astro` |
| `GET /builds/<id>` | status, tier, log, stats, output links |
| `GET /b/<id>/` | the output's paths |
| `GET /b/<id>/<file>` | `wrangler.json`, `worker.js`, `worker.js.map`, `assets/…`, `migrations/…` |
| `GET /b/<id>/project.zip` | the whole output, streamed |
| `GET /b/<id>/loader.json` | `{ compatibilityDate, compatibilityFlags, mainModule, modules }` |
| `POST /builds/claim` | runner: the next queued build, or `204` |
| `GET /builds/<id>/input.zip`, `PUT /builds/<id>/output`, `POST /builds/<id>/fail` | runner: inputs, output (`x-build-stats`), failure |

A build id is the hash of the builder version, the inputs and the spec. The same build is never
made twice.

### Functions

| Export | What it does |
|---|---|
| `buildProject({ files, esbuild, packages?, spec?, log? })` (`.`) | a project (wrangler.jsonc and `main`) → `{ config, files, stats }` |
| `buildAny(…)` (`./any`) | the same, building an Astro project from its sources first |
| `loaderPayload(output)` | a Worker Loader payload of a build |
| `defaultPackages(fetch?)` | packages from `node_modules`, then the registry (or the package store) |

`BuildSpec` fields:

| Field | Meaning |
|---|---|
| `entry` | the entry module (default: wrangler `main`) |
| `kind` | `worker`, `browser` or `astro` (default: `astro` with an `astro.config.*`, else `worker`) |
| `minify` | minify the output |
| `sourcemap` | write `worker.js.map` (default `true`) |
| `lowerAwait` | lower `await` (AsyncLocalStorage polyfills) |
| `conditions`, `external`, `define` | as in esbuild |
| `hostCompat` | wrap the entry for host compatibility (default `true`) |
| `astro` | the Astro builder's options (`preload`, `metaUrl`, `session`) |

### Node runner and CLI

```sh
npx tsx bin/webrun-build.ts <project dir> --out <dir> [--platform <origin>] [--spec <json>]
npx tsx bin/webrun-build.ts --runner <origin> [--once]
```

## How it works

- **One esbuild pass.** webrun-bundler reads every file through a FilesApi and keeps source maps
  through packages.
  - The conditions are `workerd, worker, browser`.
  - `cloudflare:*` and `node:*` stay imports (with nodejs_compat, the bare built-in names too),
    for the runtime to provide.
  - Assets and D1 migrations are copied.
- **One build, every host.** `./compat` and the build add:
  - a stable `id` for KV namespaces that lack one (celld requires it);
  - a `node:module` whose `createRequire` falls back to a `require` of the common built-ins
    (celld has none);
  - an entry that answers table-valued pragmas on celld's internal tables with no rows.
    Kysely's introspection reads every table `sqlite_master` lists, celld's included.
- **Placement.** A build larger than `IN_OBJECT_BUILD_MAX_BYTES` (8 MB), or asked with
  `tier=runner`, waits in a queue object. The Node runner claims it, builds with native esbuild,
  and uploads. A Workers isolate has 128 MB; EmDash's build needs far more.
- **Streaming.** ZIPs go out one file at a time, which keeps celld's isolate heap within its
  limit on a 38 MB input.

```sh
pnpm --filter @statewalker/cellb-bundler test
```
