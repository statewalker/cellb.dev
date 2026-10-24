# cellb.dev monorepo: extract webrun-cells with its history, then reorganise it into deep modules

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or
> superpowers:executing-plans) to carry this out task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** webrun-cells leaves `statewalker-sandbox` for its own `cellb.dev` monorepo. Every commit
that touched it comes along, authored by `Mikhail Kotelnikov <mikhail.kotelnikov@gmail.com>` with
Claude as co-author. Then the single 12 k-line package is split along the seams it already has.

**Architecture:** two phases that never mix. **Phase A** moves the code with `git filter-repo`.
The tree stays byte-identical, so all tests must pass unchanged. **Phase B** reorganises the code
in tiny `git mv`-first commits, each green, following the deep-module rules (`codebase-design`).

**Tech stack:** git-filter-repo a40bce548d2c (`~/.local/bin`), pnpm 10, turbo, TypeScript 7,
vitest 5, Playwright, Biome.

---

## 1. What is there now

| Fact | Evidence |
|---|---|
| Lives at `apps/webrun-cells` in `statewalker-sandbox`, branch `webrun-cells` (622 commits in the monorepo) | `git log --oneline \| wc -l` |
| 113 commits touch it (+1 that touches only `.github/workflows/webrun-cells-interop.yml`), 5 of them merges, from 2026-09-29 on | `git log -- apps/webrun-cells` |
| Authors: 76 `Claude (for Mikhail Kotelnikov)`, 37 `Mikhail Kotelnikov`. 76 + 1 commits have no `Co-Authored-By` | trailer count |
| Nothing else in the sandbox depends on it | `grep webrun-cells */*/package.json` |
| It needs only one thing from the sandbox: catalog versions (webrun-site-*, webrun-modules, webrun-http-browser, vite, vitest, typescript, ws, @types/*) and the root Biome config (`extends: "//"`) | `pnpm-workspace.yaml`, `biome.json` |
| `src/`: 12 353 lines in 15 directories, one package, ~80 names exported from `src/index.ts` | `wc -l` |
| Commit SHAs named in `docs/notes` (05, 07, 16) belong to *other* repositories (workers-sdk, webrun-sites), so rewriting this history breaks none of them | `git cat-file -t` |
| `x.db` (a SQLite file) is committed at the package root | `git ls-files x.db` |

### The directory dependency graph (imports between `src/*` directories)

```
            ltx ◄──── bucket ◄──────────────┐
                        ▲                    │
 v8 ◄─── core ──► lease │                adapters ──► lease
  ▲      ▲ │ ▲          │                    │
  │      │ │ └── ws ──► bindings ◄── isolate ◄┘
  │      │ ▼     ▲        │  ▲  └──► isolate        (cycle: bindings ⇄ isolate)
  │   transport ─┘        │  │
  │      ▲                ▼  │
  └──  router          core  miniflare-compat
                                 ▲
 project ──► everything (composition root)      peer ──► bucket, core, v8, ws
```

Back-edges, i.e. the cycles a package split would turn into package cycles:

1. `core/runtime.ts → transport/cells-http.ts → core/{id,namespace,runtime}` (core ⇄ transport)
2. `core/{runtime,namespace}.ts → ws/{server,upgrade}.ts`, and `ws/server.ts` re-exports
   `bindings/cache.js` and `bindings/html-rewriter.js`, which import `core` (core → ws → bindings → core)
3. `bindings/worker-loader.ts → isolate/host.ts` (the `ISOLATED` marker), while `isolate → bindings` (bindings ⇄ isolate)

### Findings in `codebase-design` terms

- **The leaves are already deep.** `ltx/` (LTX v3: CRC-64, LZ4, xxHash32, 472 lines) and `v8/`
  (V8 structured serialisation, 565 lines) import nothing else in the repository. Each has a
  two-function interface (`encodeLtx`/`decodeLtx`, `serialize`/`deserialize`) and is checked
  against celld's own bytes. These are the cheapest, safest packages to cut out.
- **`ports.ts` is the real seam.** Each port has two or more adapters: SQL (`node-sqlite`,
  `wasm-sqlite`), leases (`sqlite-lease`, `registry-lease`, `cas-lease`), object stores (`s3`,
  `sqlite`, `celld-cells`) and logs (`files-changelog`, `files-ltx`, `ltx-log`). The runtime/storage
  split goes there.
- **The interface is too wide.** `src/index.ts` exports ~80 names, including transport internals
  (`stripControl`, `withScheme`, `postVia`, `H as CELLS_HEADERS`) that only the browser fixtures
  use. That makes the package shallow from the outside. Each new package gets a deliberately small
  `index.ts`. Internals stay importable for its own tests, but not from the package root.
- **`project/` is the composition root.** It imports 9 of the 14 other directories (36 imports),
  14 of them from `bindings`. It is the host, not a library layer, and becomes the app-level package.
- **`peer/` has no production caller.** Only `test/p10c` and `test/p11j` import it, and `index.ts`
  does not export it. A decision is needed (§4, D5).
- **Tests are grouped by prototype phase (`p01`…`p12`), not by seam.** After the split, each test
  moves next to the package whose interface it exercises. Replace, don't layer: no test is rewritten
  in this plan, only moved.

## 2. Target shape

```
cellb.dev/                         (new git repository)
├─ package.json  pnpm-workspace.yaml  turbo.json  biome.json  tsconfig.base.json
├─ .github/workflows/interop.yml
├─ packages/
│  ├─ ltx/            ← src/ltx                        leaf, pure
│  ├─ v8-serialize/   ← src/v8                         leaf, pure
│  ├─ runtime/        ← src/{core,ws,transport,router,lease}, ports.ts
│  ├─ storage/        ← src/{bucket,adapters}  (+ peer, per D5)
│  └─ bindings/       ← src/{bindings,isolate,miniflare-compat,node-compat}
├─ apps/
│  ├─ host/           ← src/project, browser/, scripts/, probes/   (wrangler projects on Node + Chromium)
│  └─ conformance/    ← conformance/, vendor/, the p09/p11* celld interop tests
└─ docs/notes/        ← docs/notes (01–24) + this plan
```

Dependencies point one way only:
`ltx, v8-serialize ← runtime ← storage, bindings ← host ← conformance`.

Five packages, not fifteen. A directory becomes its own package only when it is a leaf with its own
interface. Directories that call each other in both directions (core/ws/transport/router) stay
together, because one package is cheaper than a fake seam between them.

## 3. Phase A: move the code with its history (the tree does not change)

Verified as a dry run on 2026-10-24 in a scratch clone of `3f55bfba` (counts grow with every later commit; re-run the checks, not the numbers):
- 114 commits, all `Mikhail Kotelnikov <mikhail.kotelnikov@gmail.com>` (author **and** committer).
- 114/114 carry a Claude `Co-Authored-By` (existing `Claude Opus 5.5` trailers kept, 77 added).
- The `apps/webrun-cells` tree is identical to `webrun-cells` HEAD.

### Task A1: The rewrite callback, kept in the repository

**Files:** create `tools/migrate/rewrite-authors.py` (committed in the new repository as a record).

- [ ] Write the callback:

```python
# git filter-repo --commit-callback body: one author, Claude as co-author on every commit.
import re
for k in ("author", "committer"):
    setattr(commit, k + "_name", b"Mikhail Kotelnikov")
    setattr(commit, k + "_email", b"mikhail.kotelnikov@gmail.com")
msg = commit.message.rstrip(b"\n")
if not re.search(rb"(?im)^Co-Authored-By: Claude", msg):
    paras = msg.split(b"\n\n")
    tail_is_trailers = len(paras) > 1 and all(re.match(rb"^[A-Za-z-]+: ", l) for l in paras[-1].split(b"\n"))
    msg += (b"\n" if tail_is_trailers else b"\n\n") + b"Co-Authored-By: Claude <noreply@anthropic.com>"
commit.message = msg + b"\n"
```

The blank-line test only looks at a final paragraph that *follows* the subject. Without that check,
one-line subjects such as `webrun-cells: lint fix` look like trailers (`key: value`), and the
co-author line is glued to the subject. The first dry run did exactly this to 28 commits.

Author and commit **dates are kept**, so `git log` still tells when work happened.

### Task A2: Extract into a fresh bare repository

- [ ] `git clone --no-local --branch webrun-cells ~/workspace-statewalker/.git-bare/cellb /tmp/…/cellb-extract`
  (a throwaway clone: filter-repo refuses to run on a clone that is not fresh, and the source repository is never rewritten)
- [ ] Run:
  ```bash
  git filter-repo --force \
    --path apps/webrun-cells/ --path .github/workflows/webrun-cells-interop.yml \
    --path-rename .github/workflows/webrun-cells-interop.yml:.github/workflows/interop.yml \
    --commit-callback "$(cat rewrite-authors.py)"
  ```
  The package keeps its path `apps/webrun-cells/`, so the workspace root that A3 adds does not
  collide with the package's own `package.json`, and the tree check is a plain comparison. Phase B
  then moves the pieces into `packages/*` and `apps/*`, and `git log --follow` traces every file.
- [ ] Keep `.git/filter-repo/commit-map` (old SHA → new SHA) as
  `tools/migrate/commit-map.txt`, so sandbox SHAs quoted in session notes can still be looked up.
- [ ] Verify (expected values in brackets):
  - `git log --format='%an <%ae>|%cn <%ce>' | sort -u` [one line, Mikhail's address twice]
  - count commits without a Claude trailer [0]
  - `git diff --stat <sandbox webrun-cells HEAD> HEAD -- apps/webrun-cells` [empty]
  - `git log --oneline | wc -l` [114]

### Task A3: Make the repository stand alone (the first commit authored in cellb.dev)

These files come from the sandbox root, so filter-repo did not carry them.

**Files:** create root `package.json` (workspace, `packageManager: pnpm@10.16.1`), `pnpm-workspace.yaml`
(only the catalog entries listed in §1), `turbo.json`, `tsconfig.base.json`, root `biome.json`
(copied from the sandbox, because the package's `extends: "//"` needs it), `LICENSE` (MIT),
`.gitignore` (`node_modules`, `test-results`, `*.db`).
Modify `.github/workflows/interop.yml`: drop `paths:` and `working-directory: apps/webrun-cells`,
and trigger on `main`.

- [ ] `pnpm install`, which generates a fresh `pnpm-lock.yaml`. The sandbox lockfile's history is
  not carried: it describes the other 20 sandbox packages.
- [ ] `git rm --cached x.db` (a committed test leftover) in its own commit.
- [ ] Green bar, exactly as today:
  - `CELLD_BIN=~/.local/bin/celld npx vitest run` [358 passed, 7 expected fail, 1 skipped, exit 0]
  - `npx playwright test` [176 passed, 17 skipped]
  - `pnpm typecheck` and `npx biome check .` [clean]
- [ ] Commit, ending with the session's `Co-Authored-By`/`Claude-Session` lines.

### Task A4: Publish and retire the sandbox copy

- [ ] Create the GitHub repository (D1). Push `main`, and the tags if any.
- [ ] Interop CI goes green on the new repository.
- [ ] Sandbox: one commit on `webrun-cells` that deletes `apps/webrun-cells` and
  `.github/workflows/webrun-cells-interop.yml`, removes the now-unused catalog entries, and adds a
  one-line pointer to cellb.dev in the sandbox README. The branch is kept, not deleted, so the old
  SHAs stay reachable.
- [ ] Move the local layout to `~/workspace-statewalker/cellb.dev/.git-bare/cellb.dev`, with worktrees
  under `worktrees/`. The old cellb worktrees are all merged and can be pruned, after asking.

## 4. Phase B: reorganise into deep modules (each commit green, `git mv` before edits)

Every task follows the same rule: one commit **moves** files (`git mv`, no content change except
import paths). The next commit, if needed, **changes** code. Run the unit + Chromium + typecheck +
Biome bar after each. Order: break the cycles first, then cut leaves, then the middle.

### Task B1: Break back-edge 3 (bindings ⇄ isolate)
Move the `ISOLATED` marker from `isolate/host.ts` to `bindings/worker-loader.ts`, which defines the
binding that needs it. Then `isolate → bindings` is the only direction.
*Test:* `p10d-isolate-uncaught`, the worker-loader conformance scenarios.

### Task B2: Break back-edge 2 (core → ws → bindings)
Move the `caches`/`HTMLRewriter` re-exports out of `ws/server.ts` into the host's worker-globals
module, which is the one place that assembles the `cloudflare:workers` surface.
*Test:* the `cache-*` and `html-rewriter` conformance scenarios, on Node and in Chromium.

### Task B3: Cut `ltx` and `v8-serialize` (leaves)
`git mv apps/webrun-cells/src/ltx packages/ltx/src` and `git mv apps/webrun-cells/src/v8 packages/v8-serialize/src`, each with
`package.json` and an `index.ts` exporting only what `src/index.ts` exports today. Move
`p11-ltx`, `p11b-ltx-log`'s codec part and `p12-v8-serialize` with them.
*Test:* the moved tests in the new packages, plus `p11c-ltx-celld-interop` from the conformance app.

### Task B4: Cut `runtime` (core, ws, transport, router, lease, ports.ts)
Back-edge 1 (core ⇄ transport) stays inside this package on purpose. Interface = today's
`index.ts`, minus the transport internals listed in §1, which move to a `runtime/internal` subpath
that only `apps/host` imports.
*Test:* p01–p07*, p10b.

### Task B5: Cut `storage` (bucket, adapters)
These are the adapters at `ports.ts`. Platform code goes behind `exports` conditions (`./node`:
node-sqlite, `./browser`: wasm-sqlite, wasm-session, wasm-page-hook), so a browser bundle never
pulls `node:sqlite`.
*Test:* p05c/d, p06a, p10, p11b, p11d, p11e, p11h.

### Task B6: Cut `bindings` (bindings, isolate, miniflare-compat, node-compat)
*Test:* p08*, p07c, p10d.

### Task B7: what remains of `apps/webrun-cells` (`src/project`, `browser/`, `scripts/`, `probes/`) becomes `apps/host`; `conformance/` and `vendor/` become `apps/conformance`
`apps/conformance` owns `interop-env.sh` and the celld interop tests (p09, p11c, p11f, p11g, p11i, p11j).
*Test:* the full bar plus `pnpm run interop`.

### Task B8: README per package
Package shape for `packages/*`, operating-manual shape for `apps/*` and the root, following the
README rules (claims as headings, failure modes). The current README splits along the same lines,
so every section has exactly one new home.

## 5. Decisions to confirm before starting

| # | Question | Recommendation | Reversible? |
|---|---|---|---|
| D1 | GitHub home and visibility | `statewalker/cellb.dev`, public (the sandbox already is) | yes, renames redirect |
| D2 | npm names | Keep the infrastructure family prefix: `@statewalker/webrun-cells-ltx`, `-v8-serialize`, `-runtime`, `-storage`, `-bindings`, all `private` until a release | yes while private |
| D3 | Rewrite history or keep it | Rewrite (as asked). Old SHAs survive on the sandbox branch and in `commit-map.txt` | **no** once pushed and cloned |
| D4 | The one human-only commit (`Mikhail Kotelnikov`, no co-author) also gets the Claude trailer | yes, "all history" as asked | rewrite again before pushing |
| D5 | `peer/` (celld peer protocol, tested but not wired in) | move into `storage`, exported, because it is how a cell joins a celld fleet | yes |
| D6 | Phase B runs right after Phase A, or later | right after, on a `refactor/deep-modules` branch, so Phase A can ship alone | yes |

D3 is the only irreversible one (W2). It is safe at ~70 % because the sandbox branch keeps the
original commits. What is still unknown: whether anyone else has a clone of the sandbox
`webrun-cells` branch that they would rebase onto cellb.dev.

## 6. Out of scope

- Behaviour changes. Phase A changes no file. Phase B moves code and narrows exports only.
- Renaming the `p01`…`p12` test files (they move, but keep their names).
- The open items from the session thread (RustFS start-up race, Python Workers, WebSockets to
  celld-owned cells).
- Publishing any package to npm.
