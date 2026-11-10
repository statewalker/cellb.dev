# @statewalker/cellb-platform-core

> Private, not published. Used by the platform packages ([`platform`](../platform)).

## What it is

The pieces every app of the platform shares:

| Module | What it is |
|---|---|
| `./sql-files` | `SqlFilesApi`: a FilesApi on a Durable Object's `ctx.storage.sql`, in blocks of 256 KiB or less (under Cloudflare's 2 MB value limit), prefix queries as ranges (workerd limits LIKE patterns) |
| `./registry` | `PackageRegistry`: the package store, a caching proxy of the npm registry, one object per package (packuments for `PACKUMENT_TTL_S`, tarballs forever), and `handleRegistry` for `/registry/*` |
| `./registry-fetch` | `registryFetch(env)` and `remoteRegistryFetch(origin)`: fetch functions for webrun-modules' `npmRegistrySource({ fetch })` that go to the package store (no `cloudflare:*` import, so Node code uses it too) |
| `./util` | ZIP (stored, buffered or streamed one file at a time), JSONC, `subtree`, MIME types, CORS, `readUpload` |
| `./wasm` | the WebAssembly the entry provides (`provideWasm`): esbuild-wasm initialized without a worker, lightningcss-wasm initialized before webrun-modules asks for it |
| `./peers` | `projectPeers`: peer dependencies take the project's version, as npm installs them |
| `./tree` | `readTree`: a directory's files, for Node scripts |
| `./env` | `PlatformEnv`: the platform Worker's bindings |
| `./types` | ambient types of the Workers surface the packages use |

## How to use it

```sh
pnpm --filter @statewalker/cellb-platform-core test   # SqlFilesApi on node:sqlite, ZIP, JSONC
```
