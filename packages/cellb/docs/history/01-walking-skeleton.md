# 01 — P01 walking skeleton

**Objectives.** Prove the full chain in one process: a Wrangler-style Worker module
(`export default { fetch }` + `export class Counter extends DurableObject`) receives a
`Request`, resolves a stub with `env.COUNTER.getByName()`, reaches the object by `fetch`
and by JS RPC, stores in per-object SQLite and returns a `Response`.

**Conclusions.**
- The whole runtime entry point is `createCellRuntime(...).fetch(req)` — a plain
  `(Request) ⇒ Response` handler, i.e. exactly what webrun-http-browser (SW) and node:http
  mount. Ingress is therefore already solved by existing packages (wired in P04).
- `idFromName` must be synchronous (as on CF) → `crypto.subtle` is unusable; SHA-256 via
  `@noble/hashes` (namespace-scoped, 64 hex).
- Stubs are Proxies: `fetch` → fetch handler; any other property → RPC; `then` must be
  `undefined` or awaiting a stub hangs. Args/results cross a `structuredClone` boundary,
  which is what a Worker/MessagePort host will impose anyway.
- One SQLite file per cell (`{Class}/{hexId}`) + eviction = survival test for P06.

**Lessons.** Vite/vitest strips the `node:` prefix of `node:sqlite` → load it via
`createRequire`. Functions can't cross stubs, so white-box tests use a
`runInDurableObject(stub, fn)` hook (same idea as vitest-pool-workers) that still goes
through the gates.

**Code.** `src/core/runtime.ts`, `src/core/namespace.ts`, `src/core/id.ts`,
`src/core/object-host.ts`; tests `test/p01-walking-skeleton.test.ts`, fixture `test/fixtures.ts`.

**Honesty note.** The skeleton was written before its tests in this session; the red
phase was instead established by the mutation harness (`npm run mutate`).
