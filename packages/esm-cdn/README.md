# @statewalker/cellb-esm-cdn

> Private, not published. Composed by [`platform`](../platform), whose README covers running it.

## What it is

Two apps on [`@statewalker/webrun-modules`](https://www.npmjs.com/package/@statewalker/webrun-modules),
as Durable Objects that run on Wrangler (workerd), celld and CellB (Node and browsers):

- **The ESM CDN** (`ModuleHost`, `handleCdn`) serves npm packages as ES modules from your own
  origin.
- **User code as ESM** (`Project`, `handleProjects`, in `./projects`) serves a project's own files
  as ES modules, one module at a time.

## Use cases

- **A page or Worker importing npm packages** with no install step and no third-party CDN at run
  time. After the first request, everything comes from the deployment's own storage.
- **Preloading:** `?graph` lists exactly the modules an entry needs.
- **An editor, a playground or an AI agent** that writes TypeScript/TSX and wants it running at
  once in a browser. There is no bundling step, and a snapshot's URLs never change meaning.

## API

### The ESM CDN

| Request | Answer |
|---|---|
| `GET /npm/<profile>/<name>[@<range>][/<subpath>]` | `302` to the pinned URL (CORS on the redirect too) |
| `GET /npm/<profile>/<name>@<version>/<file>` | the file as ESM, `Cache-Control: immutable` |
| `GET …?graph` | JSON: every module URL the entry needs (preload list) |
| `GET …?meta` | JSON: the package's file list |
| `GET …/<file>?raw` | the original bytes |
| `GET …/<file>.css?module` | the stylesheet as a module that injects it (Lightning CSS) |

`profile` is `browser` or `node`:

- `browser`: `node:*` imports are replaced by `@jspm/core` polyfills;
- `node`: `node:*` imports are left to the runtime.

There is one `ModuleHost` object per profile.

### User code as ESM

| Request | Answer |
|---|---|
| `PUT /p/<id>/files/<path>`, `DELETE …` | writes or removes a file of the working tree |
| `GET /p/<id>/files` | the working tree's paths |
| `POST /p/<id>/import` | replaces the working tree: a ZIP, or JSON `{ files: { path: text } }` (`base64:` for bytes) |
| `POST /p/<id>/snapshots` | `{ snapshot, base }`: the tree frozen under its hash |
| `GET /p/<id>/s/<snap>/~/<path>` | a source as ESM: TS, TSX, JSX, CommonJS; CSS as `?module`; immutable |
| `GET /p/<id>/s/<snap>/` | 302 to the project's `index.html` |
| `POST /p/<id>/s/<snap>/resolve` | `{ entries }` → `{ urls, preload }` |
| `GET /p/<id>/live/…` | 302 to the latest snapshot (made on demand) |
| `GET /p/<id>/export/<snap\|live>` | the snapshot as a ZIP (what the bundler builds from) |

```sh
curl -L localhost:8787/npm/browser/lodash-es@4/merge
(cd my-app && zip -r - .) | curl -X POST --data-binary @- localhost:8787/p/my-app/import
curl -X POST localhost:8787/p/my-app/snapshots     # open <base>~/index.html
```

## How it works

- **A file in, an ES module out.** webrun-modules transforms each file on request:
  - TypeScript and JSX are stripped and compiled (sucrase);
  - CommonJS is wrapped so the module graph provides `require`;
  - bare imports are rewritten to same-origin URLs, through one `~deps` proxy per module root.
- **Packages come from the package store.** `npmRegistrySource({ fetch: registryFetch(env) })`
  sends registry requests to `PackageRegistry` objects. Transformed files are kept in the object's
  SQLite (`SqlFilesApi`).
- **A snapshot is immutable.** Its id is the hash of the tree, so its transformed modules never
  go stale. webrun-modules does not invalidate a transform when its source changes.
- **A project's npm imports bind to the CDN.** A custom endpoint resolver asks the CDN for the
  pinned URL at the range the project's `package.json` declares (a `cdn` binding). The project's
  server transforms only the project's own files, and all projects share the CDN's cache.
- **WebAssembly is provided by the entry.** workerd forbids compiling it from bytes, so the
  entry imports `lightningcss-wasm` as a module and initializes it before webrun-modules asks.
  `cjs-module-lexer` is aliased to its pure-JS build for the same reason.
