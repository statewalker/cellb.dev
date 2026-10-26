# 04 — P04 browser host

**Objectives.** Move the cells out of the caller's thread, as the browser requires:
cells + SQLite in a Dedicated Worker (OPFS persistence), HTTP ingress through the
same-origin ServiceWorker of webrun-http-browser, and stubs across the port.

Split in three, because this environment has no browser:

| Part | What | Verified here |
|---|---|---|
| P04a | `WasmSqliteDriver` (official SQLite WASM, oo1 API) + `sahpoolOpener` (OPFS) | ✅ the whole P02 suite runs against node:sqlite **and** sqlite-wasm (in-memory) |
| P04b | `serveRuntime(port)` / `connectRuntime(port)` over webrun-rpc; Request/Response envelopes; remote stubs | ✅ in-process MessageChannel **and** a real `worker_threads` Worker, including restart with state kept |
| P04c | Browser harness: `browser/cell-worker.ts`, `browser/main.ts`, SW loader, Vite config, Playwright spec | ⚠️ builds with Vite, dev server serves all assets; **e2e not run** (no Chromium, Playwright CDN blocked) |

**Conclusions.**
- The storage suite is now a driver conformance suite: `describe.each(drivers)`. Any new
  `SyncSqlDriver` (better-sqlite3, bun:sqlite, a celld-side shim) plugs into it.
- Stubs are now built on an `ObjectEndpoint { fetch, call }`: local (ObjectHost) or remote
  (port). Same `DurableObjectNamespace` class on both sides; `idFromName` is computed on
  the caller side (namespace key = class name, fetched once by `describe`), and the remote
  target is sent **by name** when it reproduces the id, so `ctx.id.name` survives.
- The input gate still serializes 30 concurrent RPCs arriving over a port — gates live
  with the object, not with the transport.
- A worker thread killed with `terminate()` (no graceful shutdown, like closing a tab)
  loses nothing already answered: the output gate only lets responses out after COMMIT.
- Browser topology: `fetch("/cells/…")` → SW (webrun-http-browser `SwHttpAdapter`, key
  `cells`) → page handler → `connectRuntime(worker)` → Dedicated Worker → DO. The SW
  cannot spawn workers, so the page owns the worker; a page-less SW path (SW → worker
  directly via a transferred port) is a follow-up.
- opfs-sahpool needs no COOP/COEP headers → deployable on any static host.

**Lessons.**
- `new Request(url, swRequest)` throws in Chromium for streamed bodies (needs
  `duplex: "half"`); rebuild the request from a buffered body instead.
- sqlite-wasm must be excluded from Vite's dep optimizer (it locates its `.wasm` next to
  the module). `installOpfsSAHPoolVfs` exists only in browser workers — Node tests use
  `wasmMemoryOpener`.
- Bodies are buffered (ArrayBuffer) across the port. Streaming and WebSockets need
  `@statewalker/webrun-http-streams` envelopes (P07).
- `pkill -f vite` inside a shell whose own command line contains "vite" kills the shell.

**To run P04c locally.** `npx playwright install chromium && npm run e2e` — four specs:
page `fetch` → DO (10 concurrent), OPFS persistence across reload, RPC from the page,
iframe navigation to a DO-served URL.

**Open.** Pool capacity: each sahpool DB takes ~2 slots (db + journal); many cells need
`reserve(n)` or a per-cell pool policy. One worker hosts all cells for now; per-namespace
or per-cell workers (isolation, CPU watchdog via `terminate()`) come with P08.

**Code.** `src/adapters/wasm-sqlite.ts`, `src/transport/{port,http-envelope}.ts`,
`src/core/namespace.ts` (`ObjectEndpoint`), `browser/*`, `playwright.config.ts`;
tests `test/p02-sync-sql-kv.test.ts` (driver matrix), `test/p04-port-host.test.ts`,
`test/cell-worker.entry.ts`.

## Update — P04c run in Chromium

Playwright's browser packages on npm (`playwright-chromium`, `@playwright/browser-chromium`)
are ~16 kB stubs that download from the Playwright CDN, which is blocked here. The npm
package **`@sparticuz/chromium`** ships a full headless Chromium (153) inside its tarball;
Playwright drives it through `launchOptions.executablePath` (`PW_CHROMIUM` env,
`npm run e2e:npm-chromium`).

Result: **4/4 browser specs pass** (SW → page → Dedicated Worker → DO; OPFS persistence
across reload; RPC from the page; iframe navigation to a DO-served URL).
Red check: swapping the sahpool opener for in-memory SQLite makes the persistence spec
fail (expected 7, received 0); restoring it turns it green again.

Caveat: this is a headless shell built for Lambda, one major version ahead of what
Playwright 1.63 pins — good enough for these specs; use `npx playwright install chromium`
where the CDN is reachable.
