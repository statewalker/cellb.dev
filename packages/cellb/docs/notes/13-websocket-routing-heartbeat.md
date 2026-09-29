# 13 — WebSockets across the ServiceWorker and shards; heartbeat; webrun-modules in the SW

**Objectives.** Validate in a real browser what notes/12 only designed: a page's
`new WebSocket(url)` reaching a Durable Object in a shard worker, locally and across
shards; unmodified user code served by webrun-modules *from the ServiceWorker*; sockets
noticing a dead peer.

**Design.**
- Each shard link has a third, raw **control port** next to the two HTTP links
  (`src/ws/control.ts`). HTTP over webrun-rpc/webrun-http-streams cannot carry
  MessagePorts; the control port can (port in the payload + transfer list).
  - `router → shard  { t: "ws-connect", id: "r:<n>", url, protocols }`
  - `shard → router  { t: "ws-accept", id, protocol, port } | { t: "ws-refuse", id, message }`
  - ids `s<k>:<n>` = a Worker in shard k opened a socket to an object in another shard;
    the router forwards the port to shard k's control port.
- `CellRouter.connectWebSocket(url)` picks a live shard (round-robin, like ingress) and
  asks it to run the Worker's fetch with an Upgrade request.
- The ServiceWorker answers `{ type: "cells-ws", url }` messages from pages with the
  socket's port; `serviceWorkerConnector()` is the page-side `WebSocketConnector`.
- `cellsHttpHandler({ onUpgrade })`: a stub.fetch answered 101 in another shard hands the
  client port over the control channel and replies `200 + x-webrun-cells-ws-accepted`;
  the calling shard turns that back into `new CellsResponse(null, { status: 101, webSocket })`.

**Findings (each found by a failing test).**
- `Upgrade` is **hop-by-hop**: the HTTP/1.1 wire of webrun-http-streams drops it → carried
  as `x-webrun-cells-upgrade` across links (Node test, 426 before the fix).
- `Upgrade` is a **forbidden request header** in browsers: every `new Request(...)` silently
  drops it (Node keeps it). `withUpgrade(req)` re-attaches it as an own `headers` property
  backed by a standalone `Headers` (guard "none"); applied wherever the runtime rebuilds a
  request (stub.fetch, HTTP surface helpers, connectWebSocket). Chromium test, 426 before.
- MessagePorts never report a dead peer → **heartbeat** on socket ports: the client pings
  every `heartbeatMs` (default 10 s; 1 s in the demo page) and closes 1006 after two missed
  pongs; the server end closes 1006 after three missed pings. A socket held by a tab that
  is closed now ends with `close 1006` on the other tab.
- **webrun-modules 0.2.1 runs inside a module ServiceWorker** (sucrase, acorn,
  lightningcss-wasm bundled by Vite): user sources come from a `MemFilesApi`, are served
  under `{scope}modules/`, and their `~deps` proxies read `globalThis.__webrunHostRegistry`
  of the realm that imports them — the page (WebSocket over ports) or the shard worker
  (WebSocketPair, 101-capable Response, `cloudflare:workers`).

**Verified.** Node: 3 routing tests with 3 worker-thread shards (local + cross-shard
broadcast, refused upgrade, lost owner), 3 heartbeat tests. Chromium: page sockets to a
Room on either shard with broadcast and clean close; unmodified client/worker sources from
the SW module server; socket closes 1006 when the hosting tab dies.

**Open.** Hibernation API; backpressure (`bufferedAmount` is 0); heartbeat cost for many
idle sockets; the Worker's stateless fetch for upgrades could run in the SW itself.

**Code.** `src/ws/{control,sw-connector,upgrade}.ts`, `src/router/{cell-router,shard-host}.ts`,
`src/transport/cells-http.ts`, `browser/sharded/{sw,main,shard-worker,modules}.ts`,
`browser/sharded/user/*`; tests `test/p07x-websocket-routing.test.ts`,
`test/p07w-websocket.test.ts`, `browser/e2e/websocket.spec.ts`.
