# cellb: review, cleanup and restructure (structure, API, documentation)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or
> superpowers:executing-plans). Steps use checkbox (`- [ ]`) syntax. Each task is one or a few tiny
> commits that leave the full bar green: unit with celld (`CELLD_BIN`), Chromium (`playwright test`),
> `pnpm typecheck`, `biome check`.

**Goal:** `@statewalker/cellb` gets a small, supported interface (three entry points instead of 89
names plus about 80 deep imports), no import cycles, one name everywhere, and documentation that
describes the code as it is.

**Supersedes:** Phase B of `packages/cellb/docs/superpowers/plans/2026-10-24-cellb-monorepo.md`
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
│  │                CellRouter, createShardHost, WebSocket client/pair, errors embedders catch
│  ├─ node.ts       loadNodeProject, nodeSqliteOpener, sqliteObjectStore, s3ObjectStore, celldBucket, celld peers
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
import { loadNodeProject, celldBucket, sqliteObjectStore } from "@statewalker/cellb/node";
const app = await loadNodeProject(dir, { storage: celldBucket(sqliteObjectStore(file), { node }) });
await app.runtime.fetch(req);
await app.close();                       // closes runtime, then storage, in order
```

## 3. Tasks

Order: cleanup → cycles → ports → storage bundle → entry points → names → docs. Each task moves
files in a `git mv` commit (import paths only), then changes code in the next commit if needed.

### R0 cleanup (no interface change except deletions of unused names)
- [ ] Delete `x.db` and `browser/probe2/`.
- [ ] Delete `core/codec.ts`, and the `jsonCodec`, `CELLS_HEADERS`, `v8Serialize` and
  `v8Deserialize` exports (no consumers).
- [ ] **Bug, TDD:** first a failing test that a bucket store's conflict is
  `instanceof PreconditionFailedError` as exported. Then keep the `bucket/object-store` class and
  make `lease/conditional-store` import it.
- [ ] Extract the shared module-text helper, `WORKERS_MODULE_SHIM` and the Workers-globals list into
  one module each. Use `bytesToHex` from `@noble/hashes` for both `hex` copies.
- [ ] Rename the same-name pairs: `H` (cells-http vs peer), `scopeOf`, `LtxLogOptions`.

### R1 cut the cycles (no interface change)
- [ ] Move `ISOLATED` into `core/handles.ts`, next to `IsolatedClass`.
- [ ] Add `project/workers-globals-module.ts` as the `cellb:ws` globals aggregator, and drop the
  re-exports from `ws/server.ts:171,174`.
- [ ] Split `transport/cells-http.ts`: a client leaf `transport/cells-link.ts`
  (`postVia`, `httpEndpoint`, `withScheme`, headers) that imports core types only.
- [ ] Move the shared helpers of `bucket/celld-cells.ts` and `ltx-log.ts` into `bucket/celld-format.ts`.
- [ ] Guard: a test, or a `madge --circular` script in `package.json`, that fails on any new cycle.

### R2 one declaration per port
- [ ] Move `Lease`, `LeaseHandle` and `Clock` into `ports.ts`, and type `CellRuntimeOptions.ownership?: Lease`.
- [ ] `SyncSqlDriver`: keep optional only the members that one driver really lacks
  (`pageImage`, `discardDirtyPages`).
- [ ] D5: delete `CasLease`, `ConditionalStore`, `MemoryConditionalStore` and `SqliteConditionalStore` with their tests; keep `Lease`, `SqliteFileLease`, `RegistryLease` if still used, otherwise delete them too (deletion test).

### R3 `CellStorage`, one bundle instead of five hand-wired fields
- [ ] `CellStorage = { durability, backup?, ownership?, objects?, close() }`.
- [ ] `celldBucket()` returns it, and so do `filesApiChangeLog` and `filesApiLtxLog`.
- [ ] `ProjectHost.storage` and `loadNodeProject(dir, { storage })` accept it, and `close()` closes
  in the right order.
- [ ] Migrate the 17 + 18 call sites and remove the `as never` casts.
- [ ] Seam test: the p11f hand-over through the new 2-call setup. The existing tests are moved, not
  duplicated.

### R4 three entry points
- [ ] `package.json` `exports` with `.`, `./node` and `./browser`, plus `src/node.ts` and
  `src/browser.ts`. Trim `index.ts` to the embedder set.
- [ ] `browserProjectRuntime` performs the globals and isolate setup itself (the 7 steps become 1),
  and the site worker uses the same path.
- [ ] Tests and fixtures that exercise public behaviour import from the entry points. Tests of
  internals keep deep imports, because internal seams are allowed.
- [ ] Seam test: one import test per entry point that runs a counter through it (Node and Chromium).

### R5 one name: cellb
- [ ] Wire and internal names (switched freely, since both ends ship together): `x-webrun-cells-*`
  headers, the `application/x-webrun-cells-values` content type, `webrun-cells.internal`, the
  `webrun-cells:*` module specifiers, `Symbol.for("webrun-cells…")`, the `__cells*` globals, page
  titles, CI name, cache directory, error messages and prose.
- [ ] Persisted and protocol names (D7: rename, no migration): database names, OPFS pools, Web Lock
  names, the `.invalid` peer address.

### R6 documentation
- [ ] **Grilling session** on the vocabulary (scenarios in §5). Write `CONTEXT.md` term by term as
  each is resolved.
- [ ] Rename in code only the terms D8 says to rename. Glossary-driven renames are separate,
  reviewed commits.
- [ ] Rewrite the README in package shape, with claim headings and failure modes in the reader's
  words. Run every command in it before committing.
- [ ] Write the six topic pages from the still-true notes, each with a "what breaks" section.
  Resolve the contradictions while doing so: Worker Loader `globalOutbound`, note 23's duplicate
  section and its gap list.
- [ ] Write the ADRs confirmed in D9.
- [ ] Move the notes, `plan.md` and the plans to `docs/history/` with `git mv`.
- [ ] Root README: drop the "still uses the old name" paragraph.

## 4. Decisions (answered 2026-10-24)

| # | Question | Decision |
|---|---|---|
| D5 | CAS lease + ConditionalStore (test-only, duplicates `ObjectStore.put(ifMatch)`) | **delete** (`lease/cas-lease.ts`, `lease/conditional-store.ts`, `SqliteConditionalStore`, their tests); celld's ownership protocol is the multi-host story |
| D7 | Persisted/protocol names (DB names, OPFS pools, Web Locks, peer address) | **rename now**, no migration code: nothing is deployed |
| D8 | Glossary-driven code renames | **glossary first**: CONTEXT.md via grilling; code renames only where a name actively misleads, as separate reviewed commits |
| D9 | ADRs | **all nine** |

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
