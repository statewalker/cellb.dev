# 15 — WebSocket conformance: native vs webrun-cells, in Node and in Chromium

**Objective.** Test every observable WebSocket behaviour of the webrun-cells sockets
against the platform's own WebSocket, in the browser and in Node, instead of against
our own expectations.

## Method

- `test/ws-conformance.ts`: 19 cases encoding the WHATWG WebSocket behaviour, with no Node
  or DOM-only imports so the same module runs in vitest and in a page.
- `test/ws-reference-server.ts`: a real WebSocket server (`ws`) speaking the same
  echo-room protocol as the `Room` Durable Object in `test/fixtures.ts`
  (broadcast, reversed binary, `where?`, `count?`, `big:<n>`, `bye`, first subprotocol wins).
- Each case runs against:

| Runner | Implementations |
|---|---|
| `test/p07y-ws-conformance.test.ts` (Node) | Node native WebSocket ⇄ `ws`; webrun-cells in-process; webrun-cells via `CellRouter` + 3 worker-thread shards |
| `browser/e2e/ws-conformance.spec.ts` (Chromium) | Chrome's native WebSocket ⇄ `ws` (the reference); webrun-cells via ServiceWorker router → shard workers (local and cross-shard) |

Cases: open state, `url`, `extensions`, `bufferedAmount`; constants; subprotocol
negotiation; duplicate/invalid subprotocols; http→ws URL normalisation, bad schemes and
fragments; 50 unicode messages in order; ArrayBuffer / Uint8Array view / DataView / Blob
with both `binaryType`s; 1 MiB text and binary; broadcast; client close with code and
reason; close without code (1005); server close (4000); `close()` while CONNECTING;
`send()` while CONNECTING; `close()` argument validation; refused upgrade (error then
1006); `on*` and listener ordering; server sees clients leave.

## Results

- **Chrome's native WebSocket passes all 19** — it is the reference.
- **webrun-cells passes all 19** in every configuration (Node in-process, Node shards,
  Chromium through the ServiceWorker, local and cross-shard).
- **Node's native WebSocket (undici) deviates on up to 2 cases, depending on the Node
  version**: on Node 22 a refused handshake and `close()` while connecting fire `error` but
  never `close`; on Node 24.8 they close with 1002 instead of 1006; on Node 24.21 the
  refused handshake conforms, but `close()` while connecting fires `error` and `close`
  synchronously inside `close()` and leaves `readyState` at CLOSING.
  The test probes the running Node first and skips a case for that implementation only when
  its deviation is observed, so a Node upgrade cannot leave a stale skip or a false failure.

## Bugs found and fixed

1. The client accepted duplicate or non-token subprotocols and URLs with a fragment →
   now `SyntaxError`, as in browsers.
2. **Forbidden request headers.** Browsers drop every `Sec-*` header (and `Upgrade`) from
   `new Request(...)`; Node keeps them. Subprotocol negotiation therefore worked in Node
   and failed in Chromium. `Sec-WebSocket-Protocol` is now carried like `Upgrade`: an own
   `headers` property on rebuilt requests (`carryWebSocketHeaders`), and a control header
   (`x-webrun-cells-ws-protocol`) across HTTP links between shards. Only a browser run can
   catch this; the corresponding mutants live in the browser harness.

## More browser behaviours

- A Room Durable Object is a WebSocket **client** of another Room (`stub.fetch` with an
  Upgrade request, `res.webSocket.accept()`), same shard and cross-shard, subprotocol
  included.
- The server side notices a client tab that disappears without a close frame: the room
  count drops after ~3.1 s (heartbeat 1 s × 3).

## Harness lessons

- In the mutation harness's repo copy, Vite refused to serve `sqlite3.wasm` from the pnpm
  store (outside the copy), so shards never started and **every browser mutant was
  "killed" for the wrong reason**. Fixes: `server.fs.allow` includes the workspace root
  found through the real path of `node_modules`; every harness run starts with a
  **baseline** of the unmutated copy and aborts if it fails.
- Vite's dependency scan aborted on `sharded/user/*.ts` (`cloudflare:workers` only
  resolves through webrun-modules), disabling pre-bundling and reloading pages mid-test.
  Scan entries are now explicit.
- `pnpm add` rewrote the monorepo's `pnpm-workspace.yaml` (comments dropped, versions
  pinned); dependencies are now added by editing `package.json` and running install.

## After the rebase on main (TypeScript 7, vitest 5, webrun-modules 0.3)

webrun-modules 0.3 emits one shared globals proxy per directory (`~deps/~globals.js`),
evaluated once per realm. Host bindings (e.g. `WebSocket`) must therefore be registered
**before** the first served module is imported; late `registry.set` no longer reaches
modules loaded afterwards.

**Code.** `test/ws-conformance.ts`, `test/ws-reference-server.ts`,
`test/p07y-ws-conformance.test.ts`, `browser/e2e/ws-conformance.spec.ts`,
`src/ws/{client,upgrade}.ts`, `src/transport/cells-http.ts`, `src/router/shard-host.ts`,
`scripts/mutation-sandbox.mjs`, `browser/vite.config.ts`, `playwright.config.ts`.
