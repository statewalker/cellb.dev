# webrun-cells — plan

Goal: one TypeScript implementation of the Durable Objects runtime surface offered by
celld (Workers + DOs + SQLite storage + alarms + WebSockets + Worker Loader + facets),
running **purely in the browser** and **identically on a server**, built on the
statewalker stack (webrun-wire, webrun-transform, webrun-files, statewalker-db).

Reference implementation to borrow from: **Miniflare 2** (the pure-TS engine behind
Wrangler 2 `dev --local`) — ids, input/output gates, alarm store, stub model.
Spec to conform to: **celld's Cloudflare-compat surface**, with celld itself as the oracle.

## Architecture

`core/` is runtime-agnostic and depends only on ports (`src/ports.ts`):

| Port | Browser adapter | Server adapter | Prototype |
|---|---|---|---|
| `SyncSqlDriver` / `OpenCellSql` | SQLite WASM + opfs-sahpool in a Worker | node:sqlite `DatabaseSync` | P02 (node), P04 (browser) |
| `CellDurability` (+ future `CellStore`) | snapshot/changeset → FilesApi (OPFS/S3) | FilesApi S3 | P06 |
| `Lease` (single owner per shard) | `navigator.locks` per shard; SW `CellRouter` forwards to the owner's worker | S3 conditional writes + epoch fencing | P05 |
| `CellHost` (where code runs) | Dedicated Worker (in sandboxed iframe for untrusted code) | in-process / worker_threads | P04, P08 |
| `Transport` (stubs across boundaries) | HTTP surface (`cellsHttpHandler`) via webrun-http-streams over webrun-rpc (MessagePort); webrun-streams-ws/webrtc/libp2p across peers | same | P04, notes/05, P05 |
| Module source | webrun-modules (TS→ESM from FilesApi) | same | P08 |
| Ingress | webrun-http-browser ServiceWorker → `runtime.fetch` | node:http → `runtime.fetch` | P04 |

Key decisions so far:
- Storage is **SQLite-backed DO semantics only**: synchronous `ctx.storage.sql`, KV stored in `_cf_KV`.
- **Implicit transaction per turn**: first statement opens `BEGIN`, commit on the next microtask. Sync writes coalesce into one atomic commit.
- **Gates without AsyncLocalStorage**: per-object input gate + synchronous event pump; output gate = barrier over durability promises.

## Prototypes (TDD red/green, one aspect each, findings note after each)

| # | Aspect | Status |
|---|---|---|
| P01 | Walking skeleton: Request → Worker → stub (fetch + JS RPC) → SQLite → Response, in-process | ✅ done — notes/01 |
| P02 | Synchronous SQL cursor API, implicit transactions, `transactionSync`, KV over SQL (sync + async), async `transaction()` | ✅ done — notes/02 |
| P03 | Input gate, output gate, write coalescing, broken-object reset, `blockConcurrencyWhile`, `sync()` | ✅ done — notes/03 |
| P04 | Browser host: DO in a Dedicated Worker, opfs-sahpool `SyncSqlDriver`, ingress via webrun-http-browser SW, stubs over MessagePort | ✅ done (Node + Chromium e2e 4/4) — notes/04 |
| P05 | Ownership: fixed shards; ServiceWorker `CellRouter` + one worker per shard over MessagePorts; Web Locks per shard across tabs; S3-CAS lease on server | ✅ a (Node) + b (Chromium) — notes/06; ✅ c: server leases (SQLite file lock, CAS + fenced manifest) and liveness — notes/07; ✅ d: Miniflare-4 heartbeat registry — notes/10 |
| P06 | Durability: ✅ a — periodic backup callback + FilesApi adapter, restore on open (notes/11); ✅ OPFS e2e (notes/14); ⏳ b — changesets, output gate, epoch fencing | |
| P07 | Alarms (⏳) + WebSockets: ✅ WebSocketPair/CellsResponse/WHATWG client over ports, injected via webrun-modules ~deps (notes/12); ✅ SW/page port routing + cross-shard + heartbeat (notes/13); ⏳ hibernation | |
| P08 | Worker Loader (`LOADER.get(hash, …)`) + facets, code built by webrun-modules, `cloudflare:workers` via `~deps/` | |
| P09 | Conformance suite run against node host, browser host and real `celld dev` | |

Mutation harness: `npm run mutate` — every known defect must break at least one test.

Server ownership: `RegistryLease` (Miniflare 4 heartbeat registry, notes/10) + exclusive SQLite files as fence.

WebSocket conformance (19 WHATWG cases, native vs webrun-cells, Node + Chromium): ✅ notes/15.
