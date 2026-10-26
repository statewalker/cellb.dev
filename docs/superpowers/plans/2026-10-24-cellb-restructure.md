# cellb: review, cleanup and restructure (structure, API, documentation)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or
> superpowers:executing-plans). Steps use checkbox (`- [ ]`) syntax. Each task is one or a few tiny
> commits that leave the full bar green: unit with celld (`CELLD_BIN`), Chromium (`playwright test`),
> `pnpm typecheck`, `biome check`.

**Goal:** `@statewalker/cellb` gets a small, supported interface (three entry points instead of 89
names plus about 80 deep imports), no import cycles, one name everywhere, and documentation that
describes the code as it is.

**Supersedes:** Phase B of `packages/cellb/docs/history/2026-10-24-cellb-monorepo.md`
(five packages). The review showed that the seam callers need is the **platform**
(isomorphic / Node / browser), not the internal directories. One package with three entry points
gives callers that seam at a fraction of the cost. Splitting `ltx` or `v8` into their own packages
stays possible later, because both are leaves, but nothing needs it now.

**Method:** Matt Pocock's `codebase-design` (depth, seams, the deletion test, "one adapter = a
hypothetical seam"), `domain-modeling` (CONTEXT.md glossary, sparing ADRs), and `tdd` (test at the
public seam only).

---

## 1. Findings (review of 2026-10-24, evidence in file:line)

### API and seams
- **The interface is wide where nobody needs it, and missing where everybody does.**
  - `src/index.ts` exports 89 names. Only 36 are imported from it, all by tests and browser fixtures.
  - About 50 names are imported nowhere: `CELLS_HEADERS`, `jsonCodec`, the `v8*` aliases, the
    segment codecs, the D1 migration helpers, the R2 classes, the gates, and others.
  - The entry points every caller needs are reachable only by deep import: `adapters/node-sqlite`
    (33 sites), `project/node-project` (13), `adapters/wasm-sqlite` (15), `bucket/celld-cells` (6),
    `project/site` (5).
  - `package.json` has no `exports` field, so the README's own example does not resolve.
- **Wiring is left to callers.**
  - Standing a runtime up on a fleet bucket takes three constructions, five hand-wired fields and
    three ordered `close()` calls (`test/p11f-celld-one-bucket.test.ts:78-108`). `ownership: x.ownership`
    is repeated at 17 sites and `backup: x.durability` at 18, with 10 `as never` casts.
  - A browser project takes about 7 steps (`browser/projects/project-worker.ts`). The site variant
    repeats them through a second mechanism (`site-worker.ts`).
- **Ports.**
  - Real seams: SQL (2 drivers), durability and backup (4 adapters), object store (4).
  - `ValueCodec` has one live adapter (`v8Codec`). `core/codec.ts` (73 lines, `jsonCodec`) has no consumer.
  - The ownership lease is declared twice: inline at `core/runtime.ts:44`, and as `Lease` in `lease/lease.ts:14`.
  - `Clock` lives in `lease/` but is used by `core/`.
  - `ConditionalStore` and `CasLease` duplicate `ObjectStore.put(ifMatch)`, and only tests use them.
- **A live bug.** `PreconditionFailedError` exists twice (`bucket/object-store.ts:51`,
  `lease/conditional-store.ts:12`). The index exports the lease copy, but every bucket store throws
  the other one, so `instanceof` fails for any embedder.
- **Cycles.**
  - core ⇄ transport: `runtime.ts:3` ↔ `cells-http.ts:3-8`.
  - bindings ⇄ isolate: `worker-loader.ts:3`, the `ISOLATED` symbol.
  - celld-cells ⇄ ltx-log: shared helpers.
  - core → ws → bindings is only a directory-level loop. `ws/server.ts:171,174` re-exports cache and
    HTMLRewriter because it doubles as the `webrun-cells:ws` globals module.
- **`peer/celld-peer.ts` (678 lines) is finished, not dead.** It is Node-only, and its slot is
  `CellRuntimeOptions.peers`. It belongs in the Node entry point.
- **Duplication.**
  - The module-text expression is copied 5×, the `WORKERS_MODULE_SHIM` string 3×, and the
    Workers-globals list 5×.
  - `hex` is defined twice, though `@noble/hashes` is already a dependency.
  - Strays: `x.db` (tracked, 0 bytes) and `browser/probe2/` (unreferenced).
- **Naming.**
  - Prefixes are mixed: `Cells*`, `Cf*`, `celld*`, `Cell*`.
  - Factories are mixed: `createX`, noun factories, `xOpener`, and a constant (`nodeModuleLoader`)
    next to factories (`siteModuleLoader()`).
  - The same name is used for different things: `H` 2×, `scopeOf` 2×, `LtxLogOptions` 2×.

### Domain language
- "host" has six meanings (object host, shard host, project host, platform, isolate parent, remote
  cell host). "node" means a fleet member, Node.js, and the `node:sqlite` driver. "lease" covers
  four leases (shard, cell, node, waker role).
- "generation" has four meanings (LTX chain, alarm tag, facet abort counter, list version). There
  are four sequence counters, and "snapshot" has two meanings.
- cell / object / Durable Object / scope / cellKey / actor are synonyms.
- Ownership is per shard inside a browser origin, but per cell in a fleet. Nothing names that difference.
- Several terms mean something different from Cloudflare or celld:
  - **Hibernation:** here also idle eviction.
  - **Isolate:** a realm per loaded Worker.
  - **Shard:** browser-only.

### Documentation
- **The package README misleads in four places:**
  - The import snippet does not resolve.
  - The workflow path is wrong.
  - It says the remaining gaps are "in notes 08/09", but those notes are stale and the README's own
    table says the gaps are done.
  - The layout section omits 9 of the 15 `src` directories.
- **The README is missing sections:** "Why it exists", Examples, Internals, License, and any failure modes.
- **Its headings are labels, and it uses prototype-phase language** (test counts that go stale, `pNN`).
- **Notes.** Notes 03, 05, 06, 07, 10, 13, 15, 21, 22, 23 and 24 hold still-true design. The rest are
  session logs. Notes 08, 09 and `plan.md` are superseded. Several notes contradict the code or each
  other: 02, 20, 21 and 22 vs 23, and Worker Loader `globalOutbound` in 20 vs 24.
- **Note 23** repeats a section and contradicts its own "Remaining differences".
- **"webrun-cells" appears about 400 times.**
  - Most are prose.
  - Some are **persisted or protocol names**:
    - the database names `__webrun-cells/alarms` (`core/runtime.ts:143`) and `__webrun-cells/cron`
      (`project/wrangler.ts:238`);
    - the OPFS pool names (`adapters/wasm-sqlite.ts:220`, `browser/sharded/shard-worker.ts:50`);
    - the Web Lock names `webrun-cells:shard:` and `webrun-cells:owner:`;
    - the peer address `<node>.webrun-cells.invalid` (`bucket/celld-cells.ts:65`), written into celld's records.

## 2. Target shape

```
packages/cellb/
├─ package.json   exports: "."  "./node"  "./browser"      (source .ts; a build step comes with publishing)
├─ src/
│  ├─ index.ts      isomorphic (~30 names): DurableObject, WorkerEntrypoint, createCellRuntime,
│  │                createProjectRuntime, CellStorage, port types, serveRuntime/linkOverPort/connectRuntime,
│  │                CellRouter, createShardWorker, WebSocket client/pair, errors embedders catch
│  │                (celldBucket, s3ObjectStore and memoryObjectStore are isomorphic, so they live here)
│  ├─ node.ts       loadNodeProject, applyNodeD1Migrations, nodeSqliteOpener, sqliteObjectStore, celld peers
│  └─ browser.ts    browserProjectRuntime (installs Workers/node globals itself), sahpoolOpener,
│                   createProjectSite, serviceWorkerConnector
├─ CONTEXT.md       glossary (domain-modeling), no implementation detail
├─ README.md        package shape: what, why, how to use, examples, internals, license
└─ docs/
   ├─ architecture.md · browser-host.md (+ browser-host-s3.md) · ownership-and-durability.md
   ├─ celld-compatibility.md · conformance.md · gaps.md
   ├─ adr/NNNN-*.md  only the decisions confirmed in §4
   └─ history/       notes 01–24, plan.md, the two superpowers plans (session logs, unlinked from README)
```

**Embedder interface after R3 + R4:**

```ts
// Node, fleet bucket: 2 calls instead of ~7
import { celldBucket } from "@statewalker/cellb";
import { loadNodeProject, sqliteObjectStore } from "@statewalker/cellb/node";
const app = await loadNodeProject(dir, { storage: celldBucket(sqliteObjectStore(file), { node }) });
await app.runtime.fetch(req);
await app.runtime.close();               // closes runtime, then storage, in order
```

## 3. Tasks

Order: cleanup → cycles → ports → **test time (R7)** → storage bundle → entry points → names → docs →
test-folder layout (R8).
R7 changes tests only and goes right after R2, so every later task verifies in ~2 min, not ~7. Each task moves
files in a `git mv` commit (import paths only), then changes code in the next commit if needed.

### R0 cleanup (no interface change except deletions of unused names) — done `c95f66f..5a99cbe`
- [x] Delete `x.db` and `browser/probe2/`.
- [x] Delete `core/codec.ts`, and the `jsonCodec`, `CELLS_HEADERS`, `v8Serialize` and
  `v8Deserialize` exports (no consumers).
- [x] **Bug, TDD:** first a failing test that a bucket store's conflict is
  `instanceof PreconditionFailedError` as exported. Then keep the `bucket/object-store` class and
  make `lease/conditional-store` import it.
- [x] Extract the shared module-text helper, `WORKERS_MODULE_SHIM` and the Workers-globals list into
  one module each. Use `bytesToHex` from `@noble/hashes` for both `hex` copies.
- [x] Rename the same-name pairs: `H` (cells-http vs peer), `scopeOf`, `LtxLogOptions`.

### R1 cut the cycles (no interface change) — done `bd73947..a511d51`
The guard (`test/import-cycles.test.ts`) found a fourth cycle, `core/handles` ⇄ `core/object-host`,
removed by moving `DurableObjectClass` into `core/handles` (`09fe55f`).
- [x] Move `ISOLATED` into `core/handles.ts`, next to `IsolatedClass`.
- [x] Add `project/workers-globals-module.ts` as the `cellb:ws` globals aggregator, and drop the
  re-exports from `ws/server.ts:171,174`.
- [x] Split `transport/cells-http.ts`: a client leaf `transport/cells-link.ts`
  (`postVia`, `httpEndpoint`, `withScheme`, headers) that imports core types only.
- [x] Move the shared helpers of `bucket/celld-cells.ts` and `ltx-log.ts` into `bucket/celld-format.ts`.
- [x] Guard: a test, or a `madge --circular` script in `package.json`, that fails on any new cycle.

### R2 one declaration per port — done `0bf4707..a612c08`
Also deleted by the deletion test: `SqliteFileLease`, `RegistryLease`, `acquire` (no user outside
their tests). p10b/p10c now run on `test/memory-lease.ts`; unit 363 → 348 (p05c 8, p05d 7 tests).
- [x] Move `Lease`, `LeaseHandle` and `Clock` into `ports.ts`, and type `CellRuntimeOptions.ownership?: Lease`.
- [x] `SyncSqlDriver`: keep optional only the members that one driver really lacks
  (`pageImage`, `discardDirtyPages`).
- [x] D5: delete `CasLease`, `ConditionalStore`, `MemoryConditionalStore` and `SqliteConditionalStore` with their tests; keep `Lease`, `SqliteFileLease`, `RegistryLease` if still used, otherwise delete them too (deletion test).

### R3 `CellStorage`, one bundle instead of five hand-wired fields — done `2ff7a94`
Shape: `{ durability?, backup?, ownership?, objects?, close?() }` in `ports.ts` (both optional:
backup-only and in-process bundles have neither); 19 `as never` casts
removed, none storage-related left; `runtime.close()` backs up, closes databases, then storage.
- [x] `CellStorage = { durability, backup?, ownership?, objects?, close() }`.
- [x] `celldBucket()` returns it, and so do `filesApiChangeLog` and `filesApiLtxLog`.
- [x] `ProjectHost.storage` and `loadNodeProject(dir, { storage })` accept it, and `close()` closes
  in the right order.
- [x] Migrate the 17 + 18 call sites and remove the `as never` casts.
- [x] Seam test: the p11f hand-over through the new 2-call setup. The existing tests are moved, not
  duplicated.

### R4 three entry points — done `782631a..a04e03e`
index 50 names (+ `ports.ts`), node 7, browser 6; 42 unused names dropped from the index, no
implementation orphaned. `browserProjectRuntime({ code: { bundle } | { site }, isolateScript? })`;
the isolate worker still sets up its own realm. Self-reference resolves in Node, vitest, tsc and
Vite. Unit 352 / 7 / 1, Chromium 181 / 14. The snippet above closes through `app.runtime.close()`
(no `close()` added to `loadNodeProject`'s result).
- [x] `package.json` `exports` with `.`, `./node` and `./browser`, plus `src/node.ts` and
  `src/browser.ts`. Trim `index.ts` to the embedder set.
- [x] `browserProjectRuntime` performs the globals and isolate setup itself (the 7 steps become 1),
  and the site worker uses the same path.
- [x] Tests and fixtures that exercise public behaviour import from the entry points. Tests of
  internals keep deep imports, because internal seams are allowed.
- [x] Seam test: one import test per entry point that runs a counter through it (Node and Chromium).

### R5 one name: cellb — done `bc3349a` and the commit that ticks these boxes
The `__cells*` globals keep their names (they never carried `webrun-cells`); the interop tests'
`webrun-*` node identities and helpers became `cellb-*`. Unit 352 / 7 / 1, Chromium 181 / 14. The old
cache dir `~/.cache/webrun-cells-interop` is left on disk for manual deletion.
- [x] Wire and internal names (switched freely, since both ends ship together): `x-webrun-cells-*`
  headers, the `application/x-webrun-cells-values` content type, `webrun-cells.internal`, the
  `webrun-cells:*` module specifiers, `Symbol.for("webrun-cells…")`, the `__cells*` globals, page
  titles, CI name, cache directory, error messages and prose.
- [x] Persisted and protocol names (D7: rename, no migration): database names, OPFS pools, Web Lock
  names, the `.invalid` peer address.

### R6 documentation — done `f8e3275..2cc83dd` and the commit that ticks these boxes
No live grilling: `CONTEXT.md` holds every term as a `_(proposed)_` entry grounded in the code, the
§5 scenarios answered as recommendations, and an `## Open questions` list awaiting the user. Found
on the way and documented in `docs/gaps.md` (no code change): a runtime restores a cell only into
an empty local database, so a node that keeps its local SQLite on a fleet bucket and takes a cell
back serves old state and overwrites the other node's writes (verified: A 1, B 2, A again 2).
- [x] **Grilling session** on the vocabulary (scenarios in §5). Write `CONTEXT.md` term by term as
  each is resolved. — proposed entries + open questions; awaiting the user.
- [x] Rename in code only the terms D8 says to rename. Glossary-driven renames are separate,
  reviewed commits. — none renamed; candidates are open questions in `CONTEXT.md`.
- [x] Rewrite the README in package shape, with claim headings and failure modes in the reader's
  words. Run every command in it before committing. — Node examples run in a scratch test; the
  browser example is `e2e/entry-points`; `pnpm e2e` was run for that spec only.
- [x] Write the six topic pages from the still-true notes, each with a "what breaks" section.
  Resolve the contradictions while doing so: Worker Loader `globalOutbound`, note 23's duplicate
  section and its gap list. — `browser-host.md` absorbs `browser-host-s3.md`.
- [x] Write the ADRs confirmed in D9.
- [x] Move the notes, `plan.md` and the plans to `docs/history/` with `git mv`.
- [x] Root README: drop the "still uses the old name" paragraph.

### R7 test time: ~400 s → ~130 s for the unit suite (tests only, no behaviour change) — done `9a12f0a..9d6ce12`
Measured on `a511d51` (vitest JSON report): the suite takes 397 s and **one file sets it**,
`test/p11f-celld-one-bucket.test.ts` (397 s, 30 tests, ~13 s each, run one after another).
Next: `p09-celld-conformance` 129 s (`cron` alone 67 s: a fixed `waitMs: 65_000` for a real
minute boundary), `p11g-celld-rustfs` 111 s, `p11i-live-handover` 90 s; every other file < 15 s.
Each p11f test is mostly waiting: start `celld dev` and poll for "ready"; after stopping it, retry
cellb's steps every 500 ms until celld's node lease lapses (`p11f…:95-103`); a fixed 3.5 s for
cellb's own 3 s node lease (`:109`); start celld again.

Result: the unit suite 417 s → 83 s wall time (3 runs: 82.8 / 83.9 / 84.8 s, each 348 passed,
7 expected fail, 1 skipped). Per file, before (one run on `8d9ac0b`) → after (3 runs): p11f 417 →
82-84 s, p09 129 → 70 s, p11g 111 → 37-38 s, p11i 88 → 43-44 s; the rest unchanged (p11c 15 s).
`describe.concurrent.skipIf()` drops the concurrent flag in vitest 5.0.5; the celld files use
`describe.skipIf(!CELLD)(name, { concurrent: true }, …)`, and `vi.setConfig({ maxConcurrency: 4 })`
per file.

- [x] p11f: run the tests concurrently (`describe.concurrent`, a bounded pool of 4). Each test
  already has its own project dir; give each its own celld port and bucket prefix (`cells/<test>/`),
  so no two share a node record or a lease. Success: p11f ≤ 120 s, 30/30 green, run 3× in a row.
  — 101 s, 3× green (`9a12f0a`). The project dir is already the isolation key (celld dev's bucket
  is `<dir>/.celld/dev/objects.sqlite3`), so no prefix was needed; the ports moved to 19000+,
  because 18830+ ran into p11i/p11j/p11g's ports.
- [x] p11f: drop the fixed 3.5 s wait. First a failing test that `bucket.close()` leaves cellb's
  node record released (celld then takes the cell at once); then make `close()` release it if it
  does not. Keep the retry loop after stopping celld — celld's own lease lapsing is part of what the
  test proves (hand-over with no manual step). — The test passed as is (`close()` already deletes
  `nodes/<node>.json`; it failed when that line was removed), so no source change; the waits are
  gone and the hand-overs, whose celld side does not retry, guard it (`462894d`, p11f → 82 s).
  One wait stays, in "Queues: … and back": without it celld starts before webrun-cells' delayed
  message is due, and that test failed 2 of 12 runs (0 of 12 with the wait).
- [x] p09: run the scenarios concurrently (bounded pool), so `cron`'s 65 s overlaps the others
  instead of adding to them; the transcripts are per project and do not share state. Success:
  p09 ≤ 75 s. (A fake `CronClock` — `bindings/cron.ts:182` already takes one — would also work for
  cellb's side but not for the recorded celld golden, so overlap is the honest fix.) — 70 s
  (`a72f866`). The one shared thing was the console capture of user logs: one patch now routes
  each line to the scenario whose `AsyncLocalStorage` context logged it.
- [x] p11g, p11i: same bounded concurrency where the tests use distinct cells/prefixes; otherwise
  leave them (they are under the new p09 bound). — Both distinct; 37 s and 44 s (`9d6ce12`). p11j's
  WebSocket test moved from port 18884 (in p11g's range) to 18875: with p11g's nodes starting
  together it collided (celld dev did not bind, the socket got p11g's 503, a 120 s timeout).
- [x] Verify: whole unit suite ≤ 150 s wall time, counts unchanged (363 / 7 expected fail / 1 skip,
  minus R2's deletions), and the intermittent p11f delayed-queue test (§6) watched: if concurrency
  makes it flakier, that is new information about its cause — record it, do not retry it away.
  — 3× green at 83-85 s, 348 / 7 / 1. The delayed-queue test ("… sent on webrun-cells is
  delivered by celld") also failed in the unchanged baseline run. New information: the failing
  case is celld waking a message that webrun-cells left NOT yet due. Removing the wait in
  "Queues: … and back" put that test on the same path, and it failed the same way (celld never
  delivers `b-from-webrun`; both drivers failed in the same run). Under concurrency the handoff
  test itself passed in all 12 runs that included it (6 of p11f alone, 6 of the full suite), so it
  did not get flakier.

### R8 test-folder layout — done `7e01196..b4c7b4d` and the commit that ticks these boxes
The rule: unit tests in `test/`, browser unit tests in `test-browser/`, end-to-end tests in `e2e/`,
browser end-to-end tests in `e2e-browser/`; no empty folders (so no `test-browser/`: every Chromium
test drives a page through a dev server). Bar: vitest with celld 354 passed / 7 expected fail /
1 skipped (R7's 352 + the two new import-guard cases), Chromium 181 passed / 14 skipped,
`MUTANTS=0,1 pnpm mutate` and `MUTANTS=1,2 pnpm mutate:browser` kill theirs, `pnpm -r typecheck`
and `pnpm biome check .` exit 0, no stale `browser/` path outside `docs/history`.
- [x] `e2e/`: the six files that start a real celld and/or RustFS (p11c migration, p11c LTX
  interop, p11f, p11g, p11i, p11j). No other test spawns celld (p05c forks a Node child only; p09
  compares with recorded goldens). They import no test helper, so nothing else moved. vitest
  includes `test/**` and `e2e/**`; `pnpm test` runs both as before, `test:unit` / `test:e2e` one
  folder each; `pnpm interop` runs `e2e/` plus p09.
- [x] `e2e-browser/`: the Playwright specs at its top level; every page and worker of `browser/`
  under `e2e-browser/pages/` (the Vite root, so page URLs did not change); `browser/probes-e2e` →
  `e2e-browser/probes/` (the main config ignores `*.probe.spec.ts`). Playwright, Vite, tsconfig,
  package scripts, both mutation harnesses, `.gitignore`, README and `docs/browser-host.md` follow.
- [x] The isolate worker is library code: `src/isolate/isolate-worker.ts`, exported as
  `@statewalker/cellb/isolate-worker`. With Vite an embedder writes
  `import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url"` and passes
  `isolateScript: new URL(isolateWorker, import.meta.url)` (Vite does not resolve a bare specifier
  inside `new URL(…, import.meta.url)`; `?worker&url` also bundles it for a build). The no-`node:`
  import guard covers `src/browser.ts` and the worker too.

### G glossary — done `420fbaa..28dd1bf` and the commit that ticks these boxes
The user accepted every recommended answer in `CONTEXT.md`'s open questions. Bar: unit with celld
354 / 7 expected fail / 1 skip; Chromium with the celld env 181 / 14 skipped (one earlier full run
had 4 failures — celld-projects `queues` and `workflow`, site-projects `alarm` ("Execution context
was destroyed … navigation"), and websocket "a socket held by another tab's shard closes with 1006"
(30 s timeout) — that passed alone (121 / 14) and in a full rerun: a flake to watch, not traced to
the renames); typecheck and biome exit 0.
- [x] `CONTEXT.md`: entries resolved, the answers folded in, no open questions left.
- [x] `SyncSqlDriver.snapshot()` → `image()` (drivers, WASM hooks, object host, tests, the mutant's
  label). The changeset log's persisted `snapshot.sqlite` keeps its name; "snapshot" elsewhere is the
  LTX meaning.
- [x] `createShardHost` / `ShardHost` / `ShardHostOptions` → `createShardWorker` / `ShardWorker` /
  `ShardWorkerOptions`, file `router/shard-worker.ts` (`git mv` first).
- [x] The `Lease` port's comment says per cell; the name stays.

### R9 test isolation: free ports and a bucket per run — done `2d2b9db..c4e3d2d` and the commit that ticks these boxes
Goal: several worktrees run the full bar on one machine at once. Proof: two full vitest runs at
once (celld env, `RUSTFS_ENDPOINT` unset, so each started its own RustFS): both 354 / 7 expected
fail / 1 skipped; a Chromium run beside a vitest run: 181 / 14 and 354 / 7 / 1. Bar: vitest on the
shared RustFS 354 / 7 / 1, `MUTANTS=0,1 pnpm mutate` and `MUTANTS=1,2 pnpm mutate:browser` kill
theirs, `pnpm -r typecheck` and `pnpm biome check .` exit 0.
- [x] `test/free-port.ts` (listen on 0 at 127.0.0.1, close, return the port; its own module so
  Playwright's config and specs load it without `src/`): every celld (`dev --port`, fleet
  `--listen`/`--internal-listen`, `diagnose`) in p11c ×2, p11f, p11g, p11i, p11j, the celld-bucket
  spec and the celld recorder. Peer servers and the ws reference server already listened on 0.
- [x] `test/test-bucket.ts`: vitest's globalSetup; with `CELLD_BIN` set it reuses
  `RUSTFS_ENDPOINT` or starts RustFS from interop-env.sh's cache (`interop-env.sh --rustfs-bin`
  prints the binary, downloading it once) on a free port with a temp data dir, stopped on
  teardown and on process exit; then creates `cellb-<random>` with cellb's `signV4` and exports
  `TEST_BUCKET`. p11g and the celld-bucket spec use it instead of `cells`. Buckets on a shared
  RustFS are left in place; a temp RustFS takes them with its data dir.
- [x] Playwright: the same setup runs at config load, not in a globalSetup, because Playwright
  starts the webServer before globalSetup and Vite needs the port and endpoint; workers reload the
  config and reuse the values through the environment (`PW_PORT`, `TEST_BUCKET`). Vite gets
  `--port <free> --strictPort`, `baseURL` follows.
- [x] interop-env.sh still starts the shared RustFS on `RUSTFS_PORT` (default 9200) and creates
  `cells`, the host app's default bucket for manual use; CI calls only the pnpm scripts.
- [x] Left on purpose: `127.0.0.1:18701` in p09 and the browser projects page is an origin for
  in-process requests (no socket; the transcripts replace it by `{origin}`); 8443 in p04 is a URL
  only; 9200 is interop-env.sh's shared-instance default and the Vite proxy's fallback for
  `pnpm browser:dev`; 5173 appears only in a comment naming Vite's default.
- [x] Review fixes (`d6d48cc..5e5ef19`): three Node mutants followed their code to
  `transport/cells-link.ts` and `bucket/ltx-log.ts` (killed), and `pnpm mutate:check` verifies
  every Node and browser anchor (55 + 9); `wasmMemoryOpener`, `filesApiBackup` and
  `filesApiObjectStore` are exported from `.`; the README keeps its reasons without ADR links and
  `architecture.md` says what `src/core` imports; one Workers-globals module for every realm;
  `freePorts(n)`, celld killed when it does not start, `stop()` for an exited child, RustFS only
  when the run includes `e2e/`, an atomic RustFS download; "note NN" comments point at topic
  pages. vitest 354 / 7 / 1 (p11f's delayed-queue flake once; the rerun of p11f 30/30),
  Chromium 181 / 14.

## 4. Decisions (answered 2026-10-24)

| # | Question | Decision |
|---|---|---|
| D5 | CAS lease + ConditionalStore (test-only, duplicates `ObjectStore.put(ifMatch)`) | **delete** (`lease/cas-lease.ts`, `lease/conditional-store.ts`, `SqliteConditionalStore`, their tests); celld's ownership protocol is the multi-host story |
| D7 | Persisted/protocol names (DB names, OPFS pools, Web Locks, peer address) | **rename now**, no migration code: nothing is deployed |
| D8 | Glossary-driven code renames | **glossary first**: CONTEXT.md via grilling; code renames only where a name actively misleads, as separate reviewed commits |
| D9 | ADRs | **all nine** (`packages/cellb/docs/adr/`): 0001 celld's storage format is native; 0002 vendored celld JavaScript for KV, Queues and Workflows; 0003 celld as the conformance oracle; 0004 input/output gates without AsyncLocalStorage; 0005 fixed-N shards in the browser; 0006 WebSockets over MessagePorts; 0007 one isolate (realm) per loaded Worker; 0008 synchronous `idFromName`; 0009 leases chosen by deployment (Web Lock per shard in an origin, celld's ownership records on a fleet bucket) |
| D10 | RPC target: celld (refuses stubs across isolates) or workerd (passes them) — see §7 | **workerd** (decided 2026-10-26): stubs, functions and `RpcTarget` pass by reference; those cases are judged against `golden-workerd` (`judge: "workerd"`) and disagree with celld on purpose |

## 5. Grilling scenarios (domain-modeling)

1. A celld-owned cell receives a WebSocket from a browser node. Then the browser node takes the cell
   at epoch e+1. Who owns the socket, and which epoch stamps writes made from its messages?
2. A browser shard owns its cells through a Web Lock, while a fleet bucket names a node in
   `own.json`. Which one is "the owner" when they disagree?
3. Is a facet a cell? Under which lease is it fenced when its root loses ownership mid-commit?
4. A wake entry fires on the elected waker B while A's cell lease is live. Who runs `alarm()`, and
   does the alarm tag or the wake sequence decide?
5. Renaming wrangler `name` changes every id. Is it the same cell?
6. Hibernated vs evicted vs broken: three states or two? Which error does the client see in each?
7. R2 data lives inside the fleet bucket. Does any cell or lease own it?

## 6. Out of scope
- Behaviour changes other than the `PreconditionFailedError` fix.
- A build step and npm publishing (the package stays `private`).
- Splitting into several packages.
- Python Workers, and the intermittent p11f delayed-queue test (tracked separately).

## 7. RPC: what the statewalker packages give (review of 2026-10-25)

**The gap, measured.** cellb refuses an `RpcTarget` across a stub (`core/namespace.ts:16`), and a
loaded Worker's isolate talks to the host through a hand-rolled `rpcPort`
(`isolate/protocol.ts:55`): request/response with ids, errors reduced to `name` + `message`, bodies
buffered whole (`serializeRequest/Response` call `arrayBuffer()`), env values that cannot be
cloned become stubs **by env key only** (`splitEnv`). So a function or stub can be an env binding,
but never an argument, result or `props` value across the isolate.

**celld refuses the same things.** The recorded celld transcript `conformance/golden/wd-worker-loader-gaps.json`
says `DataCloneError: function () {} could not be cloned.` (`basics`), `Worker Loader env supports
only Service Binding capabilities.` (`doStubViaEnv`), `#<Object> could not be cloned.`
(`doStubViaProps`); `wd-stub-storage` fails on celld too. Matching celld — the conformance target —
therefore means *keeping* the refusal. Passing stubs is **workerd** parity, judged against
`conformance/golden-workerd/`, and it would make those cases disagree with celld. That is D10.

**`@statewalker/webrun-rpc` (webrun-wire, 0.4.3, MIT, published) — useful as the transport, not
as the RPC model.** cellb already depends on it (`transport/port.ts`: `connect`/`serve`/`overPipe`
carry cells-http over one port, with backpressure). It offers port multiplexing, streams with
backpressure and cancellation, and a typed-JSON call tier (`callPort`/`listenPort`, `NO_TIMEOUT`,
abort signals, close signals). It has **no object references**: no stubs or functions as values,
no `RpcTarget`, no pipelining, no disposal. It can replace `rpcPort` and the buffered bodies; it
cannot close the stub gap by itself.

**`@statewalker/service-rpc` (statewalker-sandbox) — not useful here.** Private, unpublished,
described by its own README as "Experimental / internal … Future uncertain". It is Comlink plus a
descriptor message and a stream protocol for async generators, over `MessagePort` or a WebSocket.
Comlink passes a reference only where the *caller* wraps the value in `comlink.proxy()`; every
property access on a proxy is async; it has no promise pipelining, and release is manual
(`releaseProxy`). Workers RPC needs references found by type (functions, `RpcTarget`, stubs) on
synchronous-looking stubs, so Comlink's model does not fit, and the stream tier duplicates
webrun-rpc's.

**What would close the gap if D10 = workerd.** Two options, both on a webrun-rpc port:
- *Cap'n Web* (`capnweb`, Cloudflare, MIT): the JavaScript implementation of exactly Workers RPC —
  `RpcTarget`, stubs both ways, promise pipelining, `using`/`Symbol.dispose`, a MessagePort
  transport. To verify at implementation: version, size, and that its serialization keeps
  structured-clone types cellb passes today (Date, Map, ArrayBuffer).
- *A reference table* in `isolate/protocol.ts` (~150 lines): functions, `RpcTarget` and stubs in
  arguments/results become `{ ref: id }`; the far side gets a proxy whose calls come back;
  release on `Symbol.dispose` and a `FinalizationRegistry`. No pipelining.
Recommendation: Cap'n Web if D10 = workerd (pipelining and disposal semantics are hard to get
right twice); nothing if D10 = celld.

## 8. Follow-up phase F (after R6; separate branch, one plan task each)

Each task is proven by a conformance case changing state (a `knownGap` removed, or a new step
recorded on celld/workerd), never by a test of the mechanism alone.

- [x] **F0 a stale local database after re-acquiring a cell** (data loss, found in R9): under a
  cell lease the local database is rebuilt from the bucket on every acquisition. Proof:
  `test/p10e-stale-local-db.test.ts` (A, B, A counts 1, 2, 3) and the OPFS step in
  `e2e-browser/opfs-bucket.spec.ts`; branch `fix/stale-local-db`.
- [x] **F1 isolate port on webrun-rpc** (D10-independent) — done on `feat/isolate-rpc`; one calls port carries both directions. Replace `rpcPort` with
  `callPort`/`listenPort` (`NO_TIMEOUT`) on a `multiplexPort` channel per direction. Errors keep
  their own properties (`code`), as stub calls in one isolate already do. Proof: a step in the
  `isolation-api` project throwing an error with `code` from a loaded Worker, recorded on celld;
  red today (`code` is lost at `protocol.ts:75`). Deletes ~50 lines.
- [x] **F2 streamed bodies across the isolate** (D10-independent) — done on `feat/isolate-rpc`; the target and URL ride in the fetch port's meta. Route the isolate's `fetch` through
  the cells-http-over-port path cellb already has (`transport/port.ts`) instead of
  `arrayBuffer()` copies. Proof: a loaded Worker streams a response whose first chunk arrives
  before its last is produced — a new step, recorded on celld.
- [x] **F3 stubs by reference** (only if D10 = workerd). Cap'n Web over the isolate port and over
  `ObjectEndpoint.call`; `RpcTarget`, functions and stubs as arguments, results, env and `props`.
  Proof: `wd-stub-storage` and the `basics`/`doStubVia*` exports of `wd-worker-loader-gaps`
  judged against `golden-workerd` (new `judge: "workerd"` field in the scenario), green.
  Done on `feat/rpc-stubs` (plan `2026-10-26-rpc-stubs.md`) with the §7 reference table, not Cap'n
  Web: Cap'n Web 0.12.0 refuses `Map`, `Set` and `RegExp`, drops custom error names and knows only
  its own stubs. Green against workerd: `wd-stub-storage`, `wd-worker-loader-stubs` (`basics`,
  `doStubViaEnv`, `doStubViaProps`, `doStubViaRpcParam`), `worker-details-rpc-target`; `test/p10f`
  for disposal. Stubs still do not cross to another node.
- [x] **F4 small known gaps** (D10-independent) — done on `feat/isolate-rpc` (binaryType, wasm/data modules, `ctx.exports.<Entrypoint>`; `sql.ingest()` skipped; plain-object `ctx.exports` stays a gap), one commit each, each removing a `knownGap`
  or adding a recorded step: WebSocket `binaryType` per project (`websocket_standard_binary_type`,
  the three global paths); `WorkerCode` data/wasm module types; `ctx.exports.<Entrypoint>`.
  `sql.ingest()` only if wanted — celld stops at an ingest error anyway.
- [x] **F5 idle databases**: `hibernateIdle` closes the SQLite handle after a second, longer idle
  time and reopens on the next event. Proof: a test counting open handles, and p07i still green.
  Done: `closeDatabaseAfterMs` (opt-in), `test/p07k-idle-databases.test.ts`.
- [x] **F6 storage round trips for Workflows and R2**, celld → cellb → celld, as p11f does for KV,
  D1 and Queues. Done on `feat/storage-roundtrips` (plan `2026-10-26-storage-roundtrips.md`): one
  Workflow instance celld → cellb → celld; R2 multipart objects both ways, which found and fixed an
  MD5 misread from the store's etag and an MD5 on cellb's multipart objects.
- [x] **F7 Firefox and WebKit**: add the Playwright projects; record what fails (module
  ServiceWorkers, OPFS sync handles, Web Locks) in `docs/gaps.md` before fixing anything.
  Done (`pnpm e2e:firefox`, `pnpm e2e:webkit`): Firefox runs green with its failures marked by
  cause; WebKit is wired but not run on this host (no `libavif16`), and is not a target for now.
- [x] **F8 await the lease release on close** (found in R3): `ObjectHost.close()` fires
  `void release()`, so `storage.close()` can overlap a release in flight and leave `own.json`
  held until its lease lapses. TDD: close, then a second node's `tryAcquire` must succeed at once
  with the store closed right after; then await the release in `close()`. Done: `test/p10e`
  (own.json released when `close()` returns).
- [x] **F9 Firefox `Request.body`** (found in F7): `createCellRuntime` installs a `request.body`
  where it is missing; cellb's rebuilt requests read the body whole where the host cannot take a
  stream. Done on `feat/firefox-request-body` (plan `2026-10-26-firefox-request-body.md`): the
  `kv`, `r2` and `miniflare` Firefox specs pass, and `peer-routing` proves the owner retry and the
  restored scheme in Firefox.
- [x] **F10 the remaining Firefox marks**: done on `fix/firefox-remaining` (plan
  `2026-10-26-firefox-remaining.md`). The two-tab `sharded` specs failed on a Playwright Firefox
  quirk (a navigation a ServiceWorker lets through loses its controller); the demo's ServiceWorker
  answers navigations. `storage.put` words its clone refusal with cellb's V8 serializer, so
  `storage-details` matches celld's golden. No `test.fail` mark is left; `browser-gaps.ts` is gone.
- [x] **F11 small gaps** (from `docs/gaps.md`): done on `feat/small-gaps` (plan
  `2026-10-26-small-gaps.md`). A WebSocket client's `bufferedAmount` counts unacknowledged bytes
  (a new `ws-conformance` case, native and cellb); isolated facets in a browser are in the fleet
  bucket and rebuilt on acquire (`opfs-bucket.spec.ts`); `sql.ingest()` as celld words it (new
  recorded project `sql-ingest`). Kept as limits, reworded: `inheritGlobalOutbound`, the input
  gate on timers (celld parity).
- Stays out, written in `docs/gaps.md` with the reason: limits per object, opaque-origin iframes
  for untrusted code, celld's log tier and `/peer/handoff`, Python Workers.
