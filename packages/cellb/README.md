# webrun-cells

Prototype of an **isomorphic Durable Objects runtime**: Cloudflare/celld-style Workers and
Durable Objects (SQLite storage, gates, stubs and RPC, WebSockets) running **entirely in the
browser** — a ServiceWorker as the single server, one Dedicated Worker per shard, SQLite on
OPFS — and the **same core on a server** (Node, `node:sqlite`, worker threads, file leases).

It is built on the statewalker stack: `webrun-rpc` + `webrun-http-streams` (HTTP over
MessagePorts), `webrun-http-browser` (ServiceWorker ingress), `webrun-files` (backup store),
`webrun-modules` (serving user code with `~deps` overrides).

Everything here is a prototype: each aspect has tests that prove it and a findings note that
explains what was learned. `docs/plan.md` is the plan; `docs/notes/NN-*.md` the notes.

## Status

94 unit tests (Node, incl. worker threads and child processes), 15 Chromium end-to-end tests,
mutation harnesses: 34/34 Node mutants and 6/6 browser mutants killed.

## Aspects, code, tests, notes

| Aspect | Code | Tests | Note |
|---|---|---|---|
| Walking skeleton: Request → Worker → stub → SQLite → Response | `src/core/{runtime,namespace,id,object-host}.ts` | `test/p01-walking-skeleton.test.ts` | 01 |
| Synchronous SQL, implicit transactions, KV over SQL (both drivers) | `src/core/{sql-storage,storage,codec}.ts`, `src/adapters/{node-sqlite,wasm-sqlite}.ts` | `test/p02-sync-sql-kv.test.ts` | 02 |
| Input/output gates, write coalescing, reset of broken objects | `src/core/{gates,object-host,state}.ts` | `test/p03-gates.test.ts` | 03 |
| Cells behind a port (worker thread / Dedicated Worker) | `src/transport/{port,cells-http}.ts` | `test/p04-port-host.test.ts`, `browser/e2e/cells.spec.ts` | 04, 05 |
| One HTTP surface on webrun-wire (streaming, scheme, errors) | `src/transport/cells-http.ts` | `test/p04-port-host.test.ts` | 05 |
| Shards, `CellRouter`, Web Locks, dead-owner detection | `src/router/*`, `browser/sharded/*` | `test/p05-router.test.ts`, `browser/e2e/sharded.spec.ts` | 06, 07 |
| Server leases: SQLite file lock, S3-style CAS + fencing | `src/lease/*`, `src/adapters/sqlite-lease.ts` | `test/p05c-lease.test.ts`, `test/p05c-exclusive-cells.test.ts` | 07 |
| Server ownership as in Miniflare 4 (heartbeat registry) | `src/adapters/registry-lease.ts` | `test/p05d-registry-lease.test.ts` | 10 |
| Durability: periodic backup callback, FilesApi, restore on open | `src/core/object-host.ts`, `src/adapters/files-backup.ts` | `test/p06a-backup.test.ts`, `browser/e2e/backup.spec.ts` | 11, 14 |
| WebSockets over MessagePorts, injected via webrun-modules `~deps` | `src/ws/{client,server,frames}.ts` | `test/p07w-websocket.test.ts` | 12 |
| WebSocket routing (SW ⇄ shards, cross-shard), heartbeat, webrun-modules in the SW | `src/ws/{control,sw-connector,upgrade}.ts`, `browser/sharded/modules.ts` | `test/p07x-websocket-routing.test.ts`, `browser/e2e/websocket.spec.ts` | 13 |

Gaps that remain (alarms, hibernation, RPC richness, Worker Loader and isolation,
changeset replication, conformance against `celld dev`) are listed in notes 08 and 09.

## Using it

```ts
import { createCellRuntime } from "@statewalker/webrun-cells";
import { nodeSqliteOpener } from "@statewalker/webrun-cells/src/adapters/node-sqlite.js";
import * as worker from "./worker.js"; // export default { fetch } + Durable Object classes

const rt = createCellRuntime({
  worker,
  durableObjects: { COUNTER: { className: "Counter" } },
  openSql: nodeSqliteOpener("./data"),
});
const res = await rt.fetch(new Request("http://local/counter/a"));
```

## Commands

| Command | What |
|---|---|
| `pnpm test` | unit tests (vitest; Node ≥ 22.13 for `node:sqlite`) |
| `pnpm typecheck` | TypeScript for `src/`, `test/` and the browser code |
| `pnpm e2e` | Chromium tests (`npx playwright install chromium` first) |
| `pnpm e2e:npm-chromium` | same, with the Chromium shipped in the npm package `@sparticuz/chromium` (no CDN access needed) |
| `pnpm mutate` / `pnpm mutate:browser` | mutation harnesses: every listed defect must make a test fail; mutants run in a throw-away copy of the app (`MUTANTS=0,3` runs a subset) |
| `pnpm probes:node` / `pnpm probes:browser` | exploratory probes (SQLite locks; MessagePort close, lock watch, SW idling) |
| `pnpm browser:dev` | demo pages: `/` (single cell worker), `/sharded/` (router + shards), `/backup/` |

## Layout

```
src/core        runtime, stubs, storage, gates (runtime-agnostic)
src/adapters    node:sqlite, sqlite-wasm (memory, OPFS), leases, FilesApi backup
src/transport   HTTP surface and port links (webrun-rpc, webrun-http-streams)
src/router      CellRouter, shard host
src/lease       Lease port, CAS lease, fenced manifest
src/ws          WebSocket client/server over ports, control channel, Upgrade helper
test/           unit tests per aspect (p01 … p07x), worker-thread/child-process fixtures
browser/        demo pages, ServiceWorker, shard workers, Playwright specs (browser/e2e)
docs/           plan and findings notes
scripts/        mutation harnesses, npm Chromium helper
probes/         hypothesis probes
```
