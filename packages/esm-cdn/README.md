# @statewalker/cellb-esm-cdn

> Private, not published. Composed by [`platform`](../platform), whose README has the details.

## What it is

Two apps of the platform on `@statewalker/webrun-modules`, as Durable Objects:

- **The ESM CDN** (`ModuleHost`, `handleCdn`): `/npm/<browser|node>/<name>[@range][/sub]`. A range
  redirects to the pinned URL; a pinned URL is immutable ESM; `?graph` lists every module an entry
  needs, `?meta` a package's files. Packages come from the package store.
- **User code as ESM** (`Project`, `handleProjects`; `./projects`): a project's files, frozen
  into snapshots named by their hash, served one module at a time (TS, TSX, JSX, CommonJS; CSS as
  `?module`). Bare imports bind to the CDN's pinned URLs at the project's `package.json` ranges.

Both run on workerd, celld and cellb (Node and browsers): the end-to-end checks are in
`packages/platform/scripts/e2e.ts`.
