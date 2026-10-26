# Firefox `Request.body` fallback — plan

Branch `feat/firefox-request-body`, package `packages/cellb`. Goal (decided by the user): when cellb
runs where `Request.prototype.body` is missing (Firefox), Worker code reading `request.body` gets a
`ReadableStream` of the body; cellb's own `req.body` paths (owner retry in `src/core/runtime.ts`,
`restoreScheme` in `src/transport/cells-http.ts`) work in Firefox. WebKit is not a target.

## Facts that shape it (probed in Playwright's Firefox 157)

- `Response.prototype.body` exists; only `Request` has the gap.
- Firefox stores a `ReadableStream` given as a request body as the text `[object ReadableStream]`.
  So a fallback stream must never be fed back into `new Request(…, { body })`.
- `@statewalker/webrun-http-streams` decides per call, with
  `Object.getOwnPropertyDescriptor(Request.prototype, "body") != null`, whether to build requests
  with stream bodies (`serveFetchOverDuplex`). A getter put *on* `Request.prototype` would flip that
  and corrupt every request body crossing a port. The getter therefore goes on a prototype inserted
  *below* `Request.prototype`: `request.body` resolves, the own-property check stays false.
- cellb substitutes its Workers globals into bundles; it installs nothing global in one place. Every
  realm that runs Worker code builds a `createCellRuntime` (browser host, isolate, shard worker,
  test workers), so the fallback is installed there; it is a no-op where `body` exists (Node,
  Chromium).

## Tasks

1. **Red: a Firefox step for the two cellb paths.** `e2e-browser/pages/peers/{index.html,main.ts}`:
   two in-page runtimes (`wasmMemoryOpener`, `MemoryLeases`, shared `filesApiChangeLog`) as in
   `test/p10c-peer-routing.test.ts`; B's link serves A's `cellsHttpHandler` under `http://link`, so a
   `POST https://app/` from B is retried at the owner (runtime.ts) and has its scheme restored
   (cells-http.ts). `e2e-browser/peer-routing.spec.ts` expects `{ n: 2, body: "via B" }`. Run
   `PW_BROWSERS=firefox npx playwright test peer-routing` → red (log
   `firefox-request-body-peers-red.log`). Add `peers/index.html` to the vite `entries`.
2. **Fallback.** `src/core/request-body.ts`: `installRequestBody()` (stream read from
   `arrayBuffer()` on first pull, `highWaterMark: 0`, `null` for GET/HEAD, one stream per request)
   and `withUrl(req, url)`: the request under another URL, its body streamed where
   `Request.prototype` owns `body`, read whole otherwise. `createCellRuntime` calls
   `installRequestBody()`. `restoreScheme` (now async) and `isolate/protocol.ts` use the shared
   `withUrl` (the local copy goes). Green: the peers spec in Firefox (log
   `firefox-request-body-peers-green.log`).
3. **Gaps flip.** Remove `NO_REQUEST_BODY` and its `kv`/`r2` (bundle, site) and `miniflare`
   `test.fail` marks. Full `pnpm e2e:firefox`: 163 + 6 passed (5 flipped + peer-routing), 11
   expected failures, 16 skipped (log `firefox-request-body-ff-after.log`; before:
   `firefox-request-body-ff-before.log`, 179 passed = 163 + 16 expected failures, 16 skipped).
4. **Docs, same commit as behaviour.** `docs/gaps.md` (Firefox section: body gap closed, paths
   entry gone; WebKit not run, not a target), `docs/browser-host.md` (same), README if it mentions
   the gap, restructure plan §8 F7 note.
5. **Bar, merge, push.** Unit (361/7/1 + nothing new on Node), Chromium (181 + 1 / 14),
   Firefox, `mutate:check`, `pnpm -r typecheck`, `pnpm biome check .`; `git merge origin/main`;
   push.

No unit test of the getter alone: on Node the fallback is a no-op, and the proof is the Firefox
specs changing state.
