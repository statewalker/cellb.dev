# Port Upstream Conformance Tests into webrun-cells — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run workerd's own Durable Object contract tests (and a residue of Miniflare v2's DO specs) unchanged on webrun-cells, in Node and in Chromium, and require the same per-test outcome that the real celld 0.6.2 produces (and, if approved, that workerd produces).

**Architecture:** No new test runner. Each upstream `*-test.js` becomes a wrangler project in `apps/webrun-cells/conformance/workerd-tests/<project>/`: the upstream file byte-identical, a generated `index.js` that calls every `test(ctrl, env, ctx)` export inside the worker and answers `{ exportName: "ok" | "<Error>: <first line>" }`, and a `wrangler.jsonc` hand-translated from the `.wd-test`. Each project gets a one-step scenario in `conformance/scenarios.ts`, so the existing machinery does the rest: `conformance/record-celld.ts` records `conformance/golden/<project>.json` from `celld dev`, `test/p09-celld-conformance.test.ts` (Node) and `browser/e2e/celld-projects.spec.ts` (Chromium) iterate `scenarios` and require identical transcripts.

**Tech Stack:** TypeScript, vitest, Playwright (Chromium 153 from `@sparticuz/chromium`), esbuild, celld 0.6.2 (`~/.local/bin/celld`), workerd test sources (Apache-2.0), optionally the `miniflare` npm package as a workerd launcher.

**Spec:** the claude.ai discussion "Finding unit tests in CellD code" (share `da9c35c8-768a-496e-ab73-0439387ed856`, snapshot saved at `~/workspace-statewalker/cellb.dev/session-da9c35c8/share-snapshot.json`; its notes live in the Drive folder `2026-10-23.DO-Test-Suites`, notes 01–04). Its conclusions, which this plan implements:
- celld's public repository has **no tests**. Its `docs/testing.md` says celld ports **workerd's DO contract tests** (`.wd-test` + JS) and checks them by differential execution against workerd.
- The best shared corpus is the DO subset of workerd's `src/workerd/api/tests`. Each module exports `{ async test(ctrl, env, ctx) }` objects and uses `node:assert`. Porting needs a config translation, a small in-worker runner, and a skip list for workerd-only features.
- The suggested order is alarms + KV storage first, then `sql-test` (1,816 lines), then block-concurrency and WebSocket hibernation, then Miniflare v2's DO specs.
- workerd's C++ tests are to be read as a specification, not ported. Current Miniflare is the least useful source.

## What already exists (do not duplicate)

| Coverage | Where | Oracle |
|---|---|---|
| 44 projects (20 celld examples + 24 ours: storage, KV, D1, R2, queues, workflows, facets, ids, assets, WS, node-compat …) | `conformance/{celld-examples,projects}`, `test/p09-*`, `browser/e2e/celld-projects.spec.ts` | golden transcripts recorded from celld 0.6.2 |
| 19 WHATWG WebSocket cases | `test/p07y-ws-conformance.test.ts`, `browser/e2e/ws-conformance.spec.ts` | the platform's native WebSocket |
| Miniflare 4 KV/D1 simulators + workerd `d1-api.ts`, unchanged | `vendor/miniflare`, `test/p08a/p08b` | their own behaviour, run unchanged |
| celld storage interop (LTX, schema, V8 values, wake index) | `test/p11*`, `test/p12` | the real celld binary (CELLD_BIN) |
| Our own expectations for SQL/KV, gates, alarms, hibernation | `test/p02, p03, p07a, p07h, p07i` | none (self-written) |

The gap this plan closes: **no upstream-authored assertions** run against webrun-cells, and **nothing compares against workerd**. Today the only oracle is celld.

## Global Constraints

- Upstream test files are copied **byte-identical** apart from one generated header line (`// VENDORED from cloudflare/workerd@<sha> <path> (Apache-2.0). Do not edit.`). This follows `scripts/vendor-miniflare.mjs` / `vendor-celld.mjs`.
- File names are kebab-case. A project directory is named `wd-<upstream basename without -test.js>`, plus `-<variant>` when one `.wd-test` defines several configs.
- Every DO class is declared in `migrations[0].new_sqlite_classes`. celld and webrun-cells are SQLite-only, so a `.wd-test` with `durableObjectStorage = (inMemory)` still gets SQLite. Say this in the README of `conformance/workerd-tests/`.
- `compatibility_date` is `"2026-01-01"`, like the existing projects. `compatibility_flags` copy the `.wd-test` flags verbatim. `experimental` is kept, because celld ignores what it does not know and so does webrun-cells.
- Commands run from `apps/webrun-cells`. Recording needs `CELLD_BIN=~/.local/bin/celld ESBUILD_DIR=$PWD/node_modules/.bin`.
- A test is green only when its transcript is **identical** to the celld golden (p09 already enforces this). Do not loosen `normalize`/`alignDocumentedDifferences` for these projects. Engine-specific noise gets a per-scenario `textMask` that says why.
- Licences: add `conformance/workerd-tests/LICENSE` (Apache-2.0 text, copied from the workerd checkout) and a `README.md` that states the pinned commit.

## Review Focus

1. **A hanging upstream test** (it awaits an alarm that never fires) must not swallow the whole project. Expected: the runner reports `"timeout"` for that export and the rest still report. *Pinned by the runner's per-export 5 s timeout (Task 1, Step 3), which Task 4's alarm projects exercise.*
2. **Export order.** The upstream tests share DO names (`idFromName('A')`) across exports, so order matters. Expected: every engine runs exports in the same order, module-namespace order (alphabetical by spec), so a recorded celld run and a webrun-cells run are comparable. workerd's own runner may use another order: if Task 2 shows an order-dependent difference, note it. *Pinned by the runner iterating `Object.keys(mod)` (Task 1); recorded celld order = webrun order is checked by p09.*
3. **Assertion messages differ between `node:assert` implementations** (Node's built-in, celld's, the browser polyfill). Expected: a failing export shows the same first line everywhere, or the scenario carries a documented `textMask`. *Pinned by the Chromium run in Task 3.*
4. **A module that fails to load** (an unsupported `cloudflare:*` / `workerd:*` import) must show as a status/body mismatch with the loader's error, not as a vitest timeout. Expected: `loadNodeProject` throws and the p09 case fails with that message. *Checked once in Task 1, Step 6: run p09 on a project whose upstream import is broken on purpose, then discard the change.*
5. **Timing-dependent tests** (`scheduler.wait(10)` vs `200`, alarms 50–500 ms) flake on a loaded machine. Expected: 3 consecutive green runs before commit. *Every task's verification step runs the scenario 3×.*

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/webrun-cells/scripts/vendor-workerd-tests.mjs` | Copies the listed upstream tests from `WORKERD_SRC` and writes each project's `index.js` + `wrangler.jsonc` from one table `WD_TESTS`. Writes `conformance/workerd-tests/projects.json` (the project names) | 1 (+ one table entry per later task) |
| `apps/webrun-cells/conformance/workerd-tests/<project>/{<upstream>.js,index.js,wrangler.jsonc}` | Generated, committed | 1, 4–9 |
| `apps/webrun-cells/conformance/workerd-tests/{LICENSE,README.md,projects.json}` | Licence, provenance, project list | 1 |
| `apps/webrun-cells/conformance/projects.ts` | `projectDir()` also looks in `workerd-tests/` | 1 |
| `apps/webrun-cells/conformance/scenarios.ts` | One scenario per `projects.json` entry; per-project overrides (`knownGap`, `textMask`, `settleMs`) in a small table | 1 |
| `apps/webrun-cells/conformance/golden/wd-*.json` | Recorded from celld | 1, 4–9 |
| `apps/webrun-cells/src/node-compat/modules.ts` + `package.json` | `node:assert` → npm `assert` for browser bundles | 3 |
| `apps/webrun-cells/conformance/record-workerd.ts`, `conformance/golden-workerd/*.json` | Optional workerd reference (open question 1) | 2 |
| `apps/webrun-cells/conformance/projects/miniflare2-details/` | Miniflare v2 residue, recorded from celld | 10 |
| `apps/webrun-cells/docs/notes/24-upstream-conformance.md`, `README.md` | Findings; aspect row + test counts | 1, updated by every task |

---

### Task 1: Vendoring + in-worker runner, proven on `actor-kv-test`

Ports workerd `src/workerd/api/tests/actor-kv-test.js` (`.wd-test`: class `ActorKvTest`, binding `ns`, flags `["experimental","nodejs_compat"]`). Parity: golden recorded from celld, compared in Node by p09.

**Files:**
- Create: `apps/webrun-cells/scripts/vendor-workerd-tests.mjs`
- Create: `apps/webrun-cells/conformance/workerd-tests/{LICENSE,README.md,projects.json}`, `conformance/workerd-tests/wd-actor-kv/{actor-kv-test.js,index.js,wrangler.jsonc}`
- Modify: `apps/webrun-cells/conformance/projects.ts` (the `projectDir` lookup)
- Modify: `apps/webrun-cells/conformance/scenarios.ts` (spread the workerd scenarios into `scenarios`)
- Modify: `apps/webrun-cells/biome.json` (`"!conformance/workerd-tests"` in `files.includes`)
- Create: `apps/webrun-cells/conformance/golden/wd-actor-kv.json` (recorded)
- Create: `apps/webrun-cells/docs/notes/24-upstream-conformance.md`; Modify: `apps/webrun-cells/README.md` (aspect row, status counts)

**Interfaces:**
- Produces, `WD_TESTS` entry shape (the only place later tasks touch the script):
  ```js
  // project name → how to build it
  { upstream: "actor-kv-test.js",            // file in src/workerd/api/tests
    durableObjects: { ns: "ActorKvTest" },   // binding → class (all become new_sqlite_classes)
    flags: ["experimental", "nodejs_compat"],
    vars: {},                                // .wd-test text/json bindings
    workerLoaders: [],                        // .wd-test workerLoader bindings → worker_loaders
    skip: [] }                                // export names never run (workerd-only), with a comment each
  ```
- Produces, runner HTTP contract (every later task relies on it): `GET /` → `200 application/json`, `{ [exportName]: "ok" | "timeout" | "<e.name>: <first line of e.message, ≤ 200 chars>" }` over the exports that have a `test` function, minus `skip`. `GET /?skip=a,b` additionally skips `a` and `b`, for splitting a known gap into its own scenario.
- Produces, scenario wiring: `scenarios["wd-<x>"] = { steps: [{ path: "/" }], ...wdOverrides["wd-<x>"] }`, where `wdOverrides: Record<string, Partial<Scenario>>` sits next to the spread in `scenarios.ts`.

- [ ] **Step 1: Shallow sparse clone of workerd, pinned**

```bash
U=/tmp/upstream && mkdir -p $U && cd $U && git clone -q --depth 1 --filter=blob:none --sparse https://github.com/cloudflare/workerd.git && cd workerd && git sparse-checkout set src/workerd/api/tests && git rev-parse HEAD
```
Expected: a SHA. Write it into `conformance/workerd-tests/README.md`.

- [ ] **Step 2: Write the scenario first (red)**

In `scenarios.ts`: read `workerd-tests/projects.json` with `readFileSync` + `new URL("./workerd-tests/projects.json", import.meta.url)`. The browser spec imports `scenarios.ts` in Node, so `node:fs` is fine there. Spread `{ [name]: { steps: [{ path: "/" }], ...wdOverrides[name] } }` into `scenarios`. Add `"wd-actor-kv"` to `projects.json` by hand for now.

Run: `pnpm vitest run test/p09-celld-conformance.test.ts -t wd-actor-kv`
Expected: FAIL (`ENOENT … golden/wd-actor-kv.json`, or no project directory).

- [ ] **Step 3: Implement `scripts/vendor-workerd-tests.mjs`**

Usage line: `WORKERD_SRC=/path/to/workerd node scripts/vendor-workerd-tests.mjs`. For each `WD_TESTS` entry it:
1. copies `src/workerd/api/tests/<upstream>` with the header line;
2. writes `wrangler.jsonc`: `name`, `main: "index.js"`, `compatibility_date`, `compatibility_flags`, `vars`, `durable_objects.bindings`, `migrations: [{ tag: "v1", new_sqlite_classes }]`, `worker_loaders`;
3. writes `index.js` from this template (the algorithm the tests cannot pin down, hence spelled out):

```js
// GENERATED by scripts/vendor-workerd-tests.mjs — runs workerd's test exports inside the worker.
import * as mod from "./<upstream>";
export * from "./<upstream>"; // the Durable Object / entrypoint classes (not `default`)
const SKIP = new Set(<skip as JSON>);
const TIMEOUT_MS = 5_000;
const first = (e) => `${e?.name ?? "Error"}: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`;
export default {
  async fetch(request, env, ctx) {
    const skip = new Set([...SKIP, ...(new URL(request.url).searchParams.get("skip")?.split(",") ?? [])]);
    const out = {};
    for (const name of Object.keys(mod)) {
      if (typeof mod[name]?.test !== "function" || skip.has(name)) continue;
      let timer;
      out[name] = await Promise.race([
        Promise.resolve().then(() => mod[name].test({}, env, ctx)).then(() => "ok", first),
        new Promise((r) => (timer = setTimeout(() => r("timeout"), TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
    }
    return Response.json(out);
  },
};
```
4. writes `projects.json` (sorted names). It does not touch `scenarios.ts`.

Copy `LICENSE` from the workerd checkout. Then run:
`WORKERD_SRC=/tmp/upstream/workerd node scripts/vendor-workerd-tests.mjs`
Expected: `conformance/workerd-tests/wd-actor-kv/` exists. `git diff` on `actor-kv-test.js` vs upstream differs only in line 1.

- [ ] **Step 4: Point `projectDir()` at the new directory**

`conformance/projects.ts`: try `projects/<name>`, then `workerd-tests/<name>`, then `celld-examples/<name>`.

- [ ] **Step 5: Record the golden from celld**

Run: `CELLD_BIN=~/.local/bin/celld ESBUILD_DIR=$PWD/node_modules/.bin npx tsx conformance/record-celld.ts wd-actor-kv`
Expected: `✓ wd-actor-kv: 1 exchanges`. Read `golden/wd-actor-kv.json`: the body should be `{ "default": "ok" }`. If celld reports a failure, keep it: that is celld's behaviour. Write it in note 24 under "celld vs workerd" (workerd passes its own test by construction at the pinned SHA).

- [ ] **Step 6: Run in Node (green), 3×, plus the load-failure check**

Run: `for i in 1 2 3; do pnpm vitest run test/p09-celld-conformance.test.ts -t wd-actor-kv || break; done`
Expected: PASS ×3. If it fails, triage per "Mismatch rule" below.
Review Focus 4: temporarily change the upstream import to `cloudflare:nope`. p09 must FAIL fast with the loader's message, not time out. Then `git checkout` the file.

- [ ] **Step 7: Note 24 + README, then commit**

Note 24 gets these sections: *Method* (runner contract, why hand-translated configs rather than a Cap'n Proto converter), *Results* table (project → celld outcome → webrun outcome), *celld vs workerd*, *Ported with changes*, *Not ported, and why* (copy this plan's "Left out" section). In the README, add an aspect row "Upstream conformance: workerd DO contract tests, unchanged" and update the status counts.

```bash
git add apps/webrun-cells/scripts/vendor-workerd-tests.mjs apps/webrun-cells/conformance apps/webrun-cells/biome.json apps/webrun-cells/docs/notes/24-upstream-conformance.md apps/webrun-cells/README.md
git commit -m "webrun-cells: workerd DO contract tests run unchanged against celld goldens (actor-kv)"
```

**Mismatch rule (applies to every task).** If webrun-cells ≠ the celld golden:
- (a) If the fix is small (one source file, ≤ ~30 lines), fix it TDD-style with the failing scenario as the red test. Commit the fix separately.
- (b) Otherwise, add the failing exports to a second scenario: `"wd-<x>-gap": { project: "wd-<x>", steps: [{ path: "/?skip=<all passing>" }], knownGap: "<one line>" }`. Pass `?skip=<failing>` in the main scenario. Record both. List the gap in note 24.

Never edit the golden by hand.

---

### Task 2: workerd as a third reference (gated by open question 1)

Proves "same as workerd" instead of assuming it. It records the same projects through Miniflare 4, which launches workerd, and checks that celld's goldens agree, except for documented disagreements.

**Files:**
- Modify: `apps/webrun-cells/package.json` (devDependency `miniflare`, exact version pinned)
- Create: `apps/webrun-cells/conformance/record-workerd.ts`
- Create: `apps/webrun-cells/conformance/golden-workerd/<name>.json`
- Modify: `apps/webrun-cells/conformance/scenarios.ts`: `Scenario.workerdDiffers?: string` (one-line reason)

**Interfaces:**
- Consumes: `projectDir`, `runScenario`, `scenarios`, `Target` from Task 1 / existing code.
- Produces: `npx tsx conformance/record-workerd.ts [name...]`. For each name it loads `wrangler.jsonc` and maps only `main`, `compatibility_date`, `compatibility_flags`, `vars`, `durable_objects` (`useSQLite: true`) to `new Miniflare({ modules: true, scriptPath, modulesRules, … })`. Any other key prints `skip <name>: <key>`. It runs `runScenario` with `fetch: (r) => mf.dispatchFetch(r)`, writes `golden-workerd/<name>.json`, then compares with `golden/<name>.json`. It exits 1 if they differ and the scenario has no `workerdDiffers`, or if `workerdDiffers` is set but they are equal (a stale entry).

- [ ] **Step 1:** add the dependency by editing `package.json`, then `pnpm install` (note 15: do not use `pnpm add`). Expected: `node -e "import('miniflare').then(m=>console.log(typeof m.Miniflare))"` prints `function`.
- [ ] **Step 2:** implement `record-workerd.ts` (above), then run `npx tsx conformance/record-workerd.ts wd-actor-kv`. Expected: `✓ wd-actor-kv agrees with celld`.
- [ ] **Step 3:** run it over every existing scenario too: `npx tsx conformance/record-workerd.ts`. For each disagreement, either set `workerdDiffers` (a known celld deviation; note 17 already lists several) or mark the project skipped for a stated reason (celld-only bindings). Expected: exit 0.
- [ ] **Step 4:** add a *celld vs workerd* table to note 24. Commit `package.json pnpm-lock.yaml conformance/record-workerd.ts conformance/golden-workerd conformance/scenarios.ts docs/notes/24-upstream-conformance.md` with message `webrun-cells: record the conformance corpus on workerd (Miniflare 4) and pin celld's deviations`.

---

### Task 3: The same projects in Chromium (`node:assert` in browser bundles)

**Files:**
- Modify: `apps/webrun-cells/src/node-compat/modules.ts` (`NODE_POLYFILL_PACKAGES["node:assert"] = "assert"`)
- Modify: `apps/webrun-cells/package.json` (dependency `assert`, exact current 2.x)
- Test: `apps/webrun-cells/browser/e2e/celld-projects.spec.ts` (unchanged; it iterates `scenarios`)

- [ ] **Step 1 (red):** `pnpm e2e browser/e2e/celld-projects.spec.ts -g wd-actor-kv`. Expected: FAIL with `node:assert is not available in browsers (nodejs_compat)`.
- [ ] **Step 2:** add the mapping and the dependency (edit `package.json`, then `pnpm install`). Do not touch `browser-registry.ts`; the module server is not on this path.
- [ ] **Step 3 (green ×3):** `for i in 1 2 3; do pnpm e2e browser/e2e/celld-projects.spec.ts -g wd- || break; done`. Expected: PASS. If a failure message differs only in the polyfill's wording (Review Focus 3), add a `textMask` for that scenario in `wdOverrides`, with a comment naming the assertion.
- [ ] **Step 4:** commit `src/node-compat/modules.ts package.json pnpm-lock.yaml conformance/scenarios.ts` with message `webrun-cells: node:assert for browser bundles; workerd tests in Chromium`.

---

### Task 4: Storage contract tests

Ports from workerd `src/workerd/api/tests/`:

| Project | Upstream | `WD_TESTS` entry |
|---|---|---|
| `wd-sync-kv` | `sync-kv-test.js` | `durableObjects: { MyActor: "MyActor" }`, flags `["enable_ctx_exports","nodejs_compat","rpc"]` |
| `wd-delete-all-deletes-alarm-enabled` | `delete-all-deletes-alarm-test.js` | `{ ns: "DurableObjectExample" }`, flags `["experimental","nodejs_compat","delete_all_deletes_alarm"]`, `vars: { EXPECT_ALARM_DELETED: "true" }` |
| `wd-delete-all-deletes-alarm-disabled` | same file | flags `[…,"delete_all_preserves_alarm"]`, `vars: { EXPECT_ALARM_DELETED: "false" }` |
| `wd-sql-restrict-names` | `sql-restrict-names-test.js` | `{ ns: "DurableObjectExample" }`, flags `["nodejs_compat"]` |

- [ ] **Step 1:** add the entries, re-run the vendor script, add the names to `projects.json` (the script does this). Expected: four new directories. Upstream files byte-identical apart from the header.
- [ ] **Step 2 (red):** `pnpm vitest run test/p09-celld-conformance.test.ts -t "wd-sync-kv|wd-delete-all|wd-sql-restrict"`. Expected: FAIL, no golden.
- [ ] **Step 3:** record: `CELLD_BIN=… ESBUILD_DIR=… npx tsx conformance/record-celld.ts wd-sync-kv wd-delete-all-deletes-alarm-enabled wd-delete-all-deletes-alarm-disabled wd-sql-restrict-names`. Then read each golden. Specifically report whether celld honours the `delete_all_*` flags (workerd's expected outcome is `ok` in both). p02 asserts "deleteAll wipes alarms" as our own expectation; if celld disagrees, this decides it.
- [ ] **Step 4 (green ×3):** Node p09 and Chromium as in Tasks 1/3, applying the Mismatch rule.
- [ ] **Step 5:** update note 24 and the README counts, then commit with message `webrun-cells: workerd storage contract tests (sync kv, deleteAll+alarm flags, sql name restrictions)`.

---

### Task 5: Alarm contract tests

| Project | Upstream | Entry |
|---|---|---|
| `wd-actor-alarms` | `actor-alarms-test.js` | `{ ns: "DurableObjectExample" }`, `["experimental","nodejs_compat"]` |
| `wd-actor-alarms-delete` | `actor-alarms-delete-test.js` | same |
| `wd-actor-alarms-in-memory` | `actor-alarms-in-memory-test.js` | `{ clearNs: "AlarmClearObject", updateNs: "AlarmUpdateObject" }`, same flags |

`actor-alarms-name-test.js` is left out: it imports `workerd:unsafe` (`unsafe.evict`), which only workerd has.

- [ ] **Steps 1–5:** as in Task 4: vendor, red, record, green ×3 in Node and Chromium (alarms are timing-dependent, Review Focus 5), then note 24 + README + commit with message `webrun-cells: workerd alarm contract tests`. Compare with `test/p07a-alarms.test.ts`. Where an upstream export now pins the same behaviour as a p07a case (e.g. "getAlarm() inside the handler is null"), note the overlap in note 24, but **do not delete p07a cases** in this plan (surgical; open question 6).

---

### Task 6: `sql-test.js` (SQLite storage, transactions, critical-error rollback)

Upstream: `sql-test.js` (1,816 lines). Exports: `default` (the 1,100-line `test(state)` body plus IO stats, streaming ingestion, foreign keys, broken-object reset, deleteAll), `testRollbackKvInit`, `testMultiStatement`, `testSessionsAPIBookmark`, `testAutoRollBackOnCriticalError`, `testCriticalErrorOnTransactionSyncRollback`, `testCriticalErrorOnTransactionSyncCommit`, `testCriticalErrorOnTransactionRollback`, `testCursorUaf`. Entry: `{ ns: "DurableObjectExample" }`, flags `["experimental","nodejs_compat","streams_enable_constructors","transformstream_enable_standard_constructor","disable_fast_jsg_struct"]`.

Known risk: the `default` body calls workerd-internal APIs early: `sql.ingest` (line ~132) and `sql.setMaxPageCountForTest`. If celld lacks them, `default` stops at its first such call on both engines. The golden then "agrees" while the remaining ~1,000 lines never run.

- [ ] **Step 1:** vendor unchanged, record, and read the `default` result.
- [ ] **Step 2 (decision rule, open question 4):** if `default` fails on celld at a workerd-internal API, and only with the user's approval, add `patches` to that entry: a list of `{ find, replace, why }` applied after copying. The `find` strings must match exactly once, or the script throws. Neutralize **only** those calls. Record the patch list in note 24 under "Ported with changes". Re-record. Expected: celld now runs past them, and its result is what both engines must match.
- [ ] **Step 3–4:** green ×3 in Node + Chromium, using the Mismatch rule. Splitting via `?skip=` works per export. A failure inside `default` cannot be split, so it gets `knownGap` with the first failing assertion quoted.
- [ ] **Step 5:** note 24 + README + commit with message `webrun-cells: workerd sql-test against celld`.

---

### Task 7: Concurrency, stubs, fetch rejection

| Project | Upstream | Entry |
|---|---|---|
| `wd-actor-block-concurrency-depth` | `actor-block-concurrency-depth-test.js` | `{ ns: "DepthTester" }`, `["experimental","nodejs_compat","js_rpc"]` |
| `wd-actor-block-concurrency-timer` | `actor-block-concurrency-timer-test.js` | `{ ns: "TimerTester" }`, same |
| `wd-actor-stub` | `actor-stub-test.js` | `{ ns: "DurableObjectExample" }`, `["experimental","nodejs_compat","js_rpc","enable_ctx_exports"]` |
| `wd-actor-fetch-rejection` | `actor-fetch-rejection-test.js` | `{ ns: "FailingActor" }`, `["nodejs_compat"]` |
| `wd-stub-storage` | `stub-storage-test.js` | `{ MyActor: "MyActor" }`, flags from its `.wd-test`. `skip` any export that needs a second service, with a comment |

These pin semantics p03 only asserts against our own expectations: the 64-level `blockConcurrencyWhile` nesting limit and its message, timers inside a critical section, and handled/unhandled rejections from stub fetches.

- [ ] **Steps 1–5:** as in Task 4. Commit message: `webrun-cells: workerd concurrency/stub contract tests`.

---

### Task 8: WebSocket contract tests

| Project | Upstream | Entry |
|---|---|---|
| `wd-websocket-hibernation` | `websocket-hibernation.js` | `{ ns: "DurableObjectExample" }`, `["experimental","nodejs_compat"]` |
| `wd-websocket-constructor` | `websocket-constructor-test.js` | no bindings, flags `["nodejs_compat","websocket_close_reason_byte_limit","pedantic_wpt","websocket_standard_binary_type"]` |

`websocket-constructor-test` builds `new WebSocket('wss://example.com/')` and checks constructor and `close()` argument rules. In a webrun-cells cell, `WebSocket` is our client (`src/ws/client.ts`), so this exercises our code. The checks run before any connection, but recording does need outbound network from celld (open question 8). It complements p07y: p07y compares against native sockets, this compares against workerd's flag-dependent rules (close-reason 123-byte limit, `binaryType` default).

- [ ] **Steps 1–5:** as in Task 4. Commit message: `webrun-cells: workerd WebSocket contract tests`.

---

### Task 9: Worker Loader contract tests

Upstream: `worker-loader-test.js` (1,449 lines, ~33 exports). Its `.wd-test` uses loaders `loader`, `sharedLoader1`/`sharedLoader2` (id `shared`), `uniqueLoader` (id `nonshared`), DO classes `FacetTestActor`, `FacetUafTestActor`, `RendezvousActor`, `StubCounter`, `TailReceiver`, a `globalOutbound`, and Python modules.

- [ ] **Step 1:** vendor with `workerLoaders: ["loader","sharedLoader1","sharedLoader2","uniqueLoader"]` and the five classes. wrangler's `worker_loaders` has no `id`, so `skip` the shared/unique-id exports, Python-module exports and Tail exports, with one comment each. Expected: `loadNodeProject` reports nothing in `unsupported` for the remaining bindings.
- [ ] **Steps 2–5:** as in Task 4. This is the deepest check of note 21's isolation and facets. Expect Mismatch-rule (b) entries. Commit message: `webrun-cells: workerd Worker Loader contract tests`.

---

### Task 10: Miniflare v2 DO behaviours not yet covered (gated by open question 7)

Miniflare v2 is not an oracle (2023 APIs, KV-backed optimistic transactions). So its *scenarios* are re-expressed as observations in a project of ours, and **celld's recording decides** the expected values. Its assertions are not copied.

Source: `cloudflare/miniflare@b536e56` `packages/durable-objects/test/storage.spec.ts` and `namespace.spec.ts`. Keep only what `projects/storage-details`, `projects/do-ids` and p03 do not already observe:

**Files:**
- Create: `apps/webrun-cells/conformance/projects/miniflare2-details/{index.js,wrangler.jsonc}`; scenario `"miniflare2-details": { steps: ["/storage","/stub"].map((path) => ({ path })) }`; golden recorded

`index.js` returns JSON from two DO methods. Each field is a `tryIt` observation, in the same idiom as `projects/storage-details/index.js`:
- `/storage`:
  - `getManyUndefinedKey`: `get(["a", undefined])`
  - `putManyUndefinedValue`: `put({ a: 1, b: undefined })`, then `get("b")`
  - `deleteManyMissing`: count
  - `listStartAndStartAfter`
  - `listOptionsNotMutated`: `JSON.stringify(opts)` before and after
  - `txnSeesUncommitted`: `get` inside `transaction` after `put`
  - `txnListIncludesNew`
  - `txnDeleteReportsNew`
  - `txnReturnValue`
  - `putThenDeleteAllSameTurn`: `get` afterwards
- `/stub`:
  - `relativeUrl`: `stub.fetch("/x")`
  - `unknownProtocol`: `stub.fetch("ftp://x")`
  - `nonResponse`: the DO `fetch` returns `{}`
  - `immutableHeaders`: setting a header on a stub response's headers

- [ ] **Steps:** write the project, red (no golden), record on celld, green ×3 in Node + Chromium, note 24, commit with message `webrun-cells: Miniflare v2 DO behaviours as celld-recorded observations`.

---

### Final verification (after the last task)

- [ ] `pnpm test` from `apps/webrun-cells`. Expected: previous 294 pass / 1 skip, plus the new p09 cases. The celld-binary tests run with `CELLD_BIN=~/.local/bin/celld ESBUILD_DIR=$PWD/node_modules/.bin pnpm test`.
- [ ] `pnpm e2e`. Expected: previous 142 plus the new `celld-projects` cases.
- [ ] `pnpm typecheck`, then `pnpm biome check --write --unsafe` from the repo root. Biome must not reformat the vendored files: Task 1 adds `"!conformance/workerd-tests"` to `files.includes` in `apps/webrun-cells/biome.json`, next to the existing `!conformance/celld-examples`.
- [ ] Note 24's results table matches the goldens. README counts updated.

## Left out deliberately

| Not ported | Why |
|---|---|
| workerd C++ tests (`io/actor-cache-test.c++`, `actor-sqlite-test.c++`, `io-gate-test.c++`, `hibernation-manager-test.c++`, `util/sqlite-*`) | Bound to workerd internals. The discussion concluded they should be read as a specification when a semantic question comes up |
| workerd WPT harness (`src/wpt/*`) and API tests for streams, URL, encoding, blob, crypto, fetch | In webrun-cells these globals are the host's (Node/Chromium), not our code. Porting would test Node and Chrome. WebSocket, the one global we implement, is covered by p07y and Task 8 |
| `kv-test`, `r2-test`, `queue-test`, `cache-*` (workerd) | They test workerd's native binding clients against mock backend workers. Our bindings are already compared with celld (`kv*`, `r2*`, `queues*` projects) |
| `js-rpc-test` and the `*rpc*` family | Need a second worker script (`js-rpc-test-target`), and the project loader binds only its own entrypoints (`wrangler.ts`). See open question 5 |
| `actor-alarms-name-test`, tail/trace/instrumentation tests, `api/node/tests` (106), Python tests | `workerd:unsafe` / tail workers / host Node / Pyodide: workerd-only or not ours |
| Current Miniflare's suite (`workers-sdk/packages/miniflare/test`) | Tests Miniflare's options and wiring. The simulators we reuse run unchanged (p08a/b), and KV/D1 behaviour is compared with celld |
| Miniflare v2 `rwmutex.spec.ts`, `plugin.spec.ts`, runner, http-server, shared storage battery | Internal to Miniflare's design. webrun-cells has no `Storage` backend interface to plug into, and p02 already runs every case on both SQLite drivers |
| celld tests | None are published. Its examples are already all ported except python/wasm/container/sandbox/pi/opencode (note 17) |

## Open questions for the user

1. **workerd reference (Task 2):** may we add `miniflare` as a devDependency (it downloads the workerd binary, ~100 MB) only to record `golden-workerd/`? Alternatives: `wrangler dev` (heavier), or skip and rely on "workerd passes its own tests at the pinned SHA". Recommendation: yes, it is the only way to *prove* workerd parity for the 44 existing projects too.
2. **When celld and workerd disagree, which does webrun-cells follow?** Current practice is celld, except for celld bugs (the assets nested-index case). Recommendation: keep celld as the target and pin every disagreement with `workerdDiffers`.
3. **Fixing mismatches:** fix in this plan only when small (Mismatch rule a), and turn everything else into `knownGap` scenarios plus a follow-up plan? Recommendation: yes. Fix scope is unknowable until the recordings exist.
4. **sql-test patches:** allow a minimal, listed, find-exactly-once patch of workerd-internal calls (`sql.ingest`, `setMaxPageCountForTest`) if celld stops there? Recommendation: yes, for `sql-test.js` only.
5. **js-rpc-test:** worth a separate plan (multi-script projects in the loader, then the RPC family)? Note 08 lists RPC richness as a known gap.
6. **Self-written tests that overlap upstream ones** (parts of p02/p03/p07a): keep them (current answer), or delete them once an upstream test pins the same behaviour?
7. **Miniflare v2 residue (Task 10):** keep or drop? Its value is modest next to Tasks 4–9.
8. **celld version and network:** goldens stay on celld 0.6.2 (the local binary; upstream is at 0.6.3). Recording `wd-websocket-constructor` and `wsclient`-style projects needs outbound network from celld. Is it available on the recording machine?
