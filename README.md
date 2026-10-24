# cellb.dev

The monorepo of **cellb** (`@statewalker/cellb`): an isomorphic Durable Objects runtime with a
celld/Cloudflare-compatible surface. The same cells run in a browser (OPFS, ServiceWorker ingress),
in Node, and alongside celld on one shared bucket.

## Layout

```
packages/cellb/        the runtime, its browser host, conformance harness and notes (see its README)
tools/migrate/         how this history was carved out of statewalker-sandbox
.github/workflows/     interop CI against the real celld and RustFS
```

## How to run it

1. `pnpm install`
2. `cd packages/cellb && pnpm test`: the unit suite. Tests that need celld skip without `CELLD_BIN`.
3. `pnpm exec playwright test`: the Chromium end-to-end suite.
4. `pnpm run interop`: the celld interop suite. `scripts/interop-env.sh` downloads the pinned celld
   and RustFS releases and starts RustFS on `127.0.0.1:9200`.

## Why the history looks the way it does

The code grew as `apps/webrun-cells` in `statewalker-sandbox`. `git filter-repo` kept every commit
that touched it and moved the paths to `packages/cellb/`, so `git log` and `git blame` work without
`--follow`. Commits Claude made alone were re-attributed to Mikhail Kotelnikov with Claude as
co-author. Every other commit is unchanged apart from its SHA. `tools/migrate/commit-map.txt` maps
each sandbox SHA to its SHA here, and `tools/migrate/rewrite-claude-alone.py` is the exact rewrite.

## What will surprise you

- Names inside the package (`webrun-cells` in prose, the `~/.cache/webrun-cells-interop` cache, CI
  job names) still use the old name. Only the npm name is `@statewalker/cellb` so far.
- A sandbox SHA quoted in an old note cannot be found here. Look it up in `commit-map.txt`.
