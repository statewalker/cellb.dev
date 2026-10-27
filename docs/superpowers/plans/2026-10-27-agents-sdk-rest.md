# Agents SDK, the rest (branch `feat/agents-sdk-rest`)

`feat/agents-sdk-full` (left unmerged, as a record) and main's cloud-session PRs solved the same
Agents SDK gaps in parallel. This branch carries onto main only what the branch adds that main still
lacks; main's mechanism wins wherever both solve the same thing. Each candidate was first checked
on main with a test. All commands run from `packages/cellb` with
`source ~/.nvm/nvm.sh >/dev/null && eval "$(scripts/interop-env.sh)"; export CELLD_BIN ESBUILD_DIR`.

This plan was written after the two tasks were done (the rules file was not available when the
work started); it records what was decided and done.

## Decisions taken before coding

- **Only one gap is real on main**: `env` and `exports` of `cloudflare:workers` in loaded Workers.
  In a Node thread the import failed to build (`No matching export ... "env"`); everywhere else a
  loaded Worker got empty objects.
- **Main's `worker-scope.ts` is the one mechanism.** The branch's `forwardTo`,
  `setRealmWorkerScope` and the proxies in `cloudflare-workers.ts` are not brought in. An isolate
  keeps its Worker's scope in `globalThis.__cellsProjectScope`, the global a browser project's
  bundle already reads (`PROJECT_WORKERS_MODULE_SHIM`); in-realm loaders give each load its own
  scope, as `bundleWorker` already does for the project.
- **Proof is p13 and the browser specs, not a conformance project.** The branch's `agents-host`
  project needs a new `judge: "workerd"` scenario; its `/env` and `/ws` steps are already covered
  on main, and the loaded-Worker steps are covered by the tests below on every host.
- **Not solved (neither branch did):** a Worker loaded into a site project's realm without
  `isolateScript` shares the realm's module registry and keeps empty objects; recorded in gaps.md.
- **Dropped as covered on main:** the `WebSocket.CONNECTING/OPEN/CLOSING/CLOSED` statics
  (`src/ws/server.ts`), `node:diagnostics_channel` and `node:os` (`src/node-compat/`), the
  flue-example state-sync test (a trial on main passed; `flue-example/test/agents-websocket.test.ts`
  covers the partyserver path), `e2e-browser/agents-sdk.spec.ts`
  (`flue-example/test/browser/flue-in-browser.spec.ts`), and the branch's second mechanisms
  (`async_hooks`, `Request`/`WebSocket` globals, browser-bundle bare names and `cloudflare:email`).

## Tasks

### T1 — loaded Workers on Node read their own `env`/`exports` (`cef36e6`)
- Test (red first): `test/p13-agents-sdk-host.test.ts`, "gives a loaded Worker its own env and
  exports" in its own thread and in the project's realm, with `test/loaded-scope-worker.ts`
  (read at load, from the entrypoint, `exports` stubs, and from a Durable Object class run as a facet).
- Fix: `src/isolate/isolate.ts` binds the realm's scope around the import; `src/project/node-project.ts`
  resolves the thread bundle's `cloudflare:workers` to a module reading it, and `nodeModuleLoader`
  passes a per-load scope to `bundleWorker`.
- Docs: `docs/gaps.md`, `docs/architecture.md`.
- Command: `pnpm vitest run test/p13-agents-sdk-host.test.ts`.

### T2 — loaded Workers in a browser read their own `env`/`exports` (`4351f97`)
- Tests (red first): `e2e-browser/agents-sdk-host.spec.ts`, the same fixture in a bundle's realm and
  in an isolate (the entry page takes `isolated`); `e2e-browser/site-projects.spec.ts`, a Worker
  loaded into an isolate on a site now reads its own (red with the old `isolate-worker.ts`).
- Fix: `src/project/browser-modules.ts` gives each in-realm load its own scope (`WORKERS_MODULE_SHIM`
  goes, now unused); `src/isolate/isolate-worker.ts` reads the realm scope for Blob-URL modules and
  a site's modules (`realmWorkerScope()` in `src/project/worker-scope.ts`).
- Docs: `docs/gaps.md`, `docs/browser-host.md`.
- Command: `pnpm exec playwright test agents-sdk-host site-projects`.

## Bar

`pnpm test`, Chromium `pnpm e2e`, `pnpm mutate:check`, `pnpm -r typecheck`, `pnpm biome check .`,
one at a time, after `git fetch` and `git merge origin/main`.
