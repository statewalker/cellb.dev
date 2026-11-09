# @statewalker/cellb-bundler

> Private, not published. Composed by [`platform`](../platform), whose README has the details.

## What it is

A project turned into one package that Wrangler (`no_bundle`), celld and cellb run as is:

- `buildProject` (`.`): `main` bundled by webrun-bundler for workerd (`cloudflare:*` and
  `node:*` left to the runtime), assets and D1 migrations copied, and the host compatibility the
  builds need (`./compat`: KV ids, `node:module`'s `createRequire`, celld's internal tables).
- `buildAny` (`./any`): an Astro project (an `astro.config.*`) built from its sources by
  [`astro-builder`](../astro-builder) first.
- `BuildJob` and `handleBuilds` (`./job`): `/builds` and `/b/<id>/…`, one object per build; a
  build too large for an isolate waits for the Node runner.
- `bin/webrun-build.ts`: the Node runner (`--runner <origin>`) and a local CLI.

```sh
npx tsx bin/webrun-build.ts ../platform/fixtures/hello-worker --out /tmp/out
pnpm --filter @statewalker/cellb-bundler test
```
