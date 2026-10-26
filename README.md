# cellb.dev

The monorepo of **cellb** (`@statewalker/cellb`): an isomorphic Durable Objects runtime with a
celld/Cloudflare-compatible surface. The same cells run in a browser (OPFS, ServiceWorker ingress),
in Node, and alongside celld on one shared bucket.

## Layout

```
packages/cellb/        the runtime, its browser host, conformance corpus and docs (see its README)
packages/flue-example/ a Flue agent app (Cloudflare target, Agents SDK) run on cellb
docs/superpowers/      plans for work on the repository
.github/workflows/     interop CI against the real celld and RustFS
```

## How to run it

1. `pnpm install`
2. `cd packages/cellb && pnpm test`: the unit tests (`test/`) and the celld end-to-end tests
   (`e2e/`), which skip without `CELLD_BIN`.
3. `pnpm exec playwright test`: the Chromium end-to-end suite.
4. `cd packages/flue-example && pnpm test`: builds a Flue app with Flue's own Cloudflare build and
   runs it on cellb against a fake model endpoint.
5. `pnpm run interop`: the celld interop suite. `scripts/interop-env.sh` downloads the pinned celld
   and RustFS releases and starts RustFS on `127.0.0.1:9200`.

## Why it is the way it is

- **One package, three entry points.** Callers differ by platform (isomorphic, Node, browser), not
  by internal module, so `@statewalker/cellb`, `/node` and `/browser` are the seams.
- **CI runs against the real celld.** celld is the conformance judge, so the interop workflow
  downloads the pinned celld and RustFS and runs the Node and Chromium interop suites on every pull
  request.

## What will surprise you

- A green `pnpm test` without `CELLD_BIN` says nothing about celld compatibility: those tests skip.
