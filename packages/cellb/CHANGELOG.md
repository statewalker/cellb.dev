# @statewalker/cellb

## 0.3.0

### Minor Changes

- f3621be: The HTTP links between a page, its shard workers and the ServiceWorker (`serveRuntime`, `connectRuntime`, `linkOverPort`, `serveHandlerOverPort`) are `@statewalker/webrun-http-browser`'s (`connectHttpLink` / `serveHttpLink`, 0.7.1), which give every exchange's multiplexed port back however it ends; cellb's own draining around them (`fetchClosing`, `servingClosing`) goes. With them come: a handler that answers first and reads the upload afterwards gets all of it, an aborted request to a handler that never answers gives its port back at once, and a request in flight when a link is closed fails (with webrun-http-browser's `LinkLostError`) instead of hanging. One behaviour change: once a response is out, a request body the handler took and stopped reading is abandoned after 30 s with no read pending (webrun-http-browser's `requestIdleMs`, not configurable through cellb yet); a handler that keeps reading keeps it. The ceiling stays 4096 requests in flight per link. Requires webrun-http-browser 0.7.1, webrun-http-streams 0.3.1, webrun-rpc 0.5.1 and webrun-streams 0.2.3.

### Patch Changes

- f334946: A WebSocket that celld tunnels to a cell cellb owns opens again when the cell picks a subprotocol: the bridge's socket to the cell now asks for the subprotocols the far client offered. With webrun-http-browser's client (a client refuses a subprotocol it did not ask for), such a socket failed with 1006. The bridge also drops malformed or (case-insensitively) duplicate subprotocols from the far client's `Sec-WebSocket-Protocol`; if the socket still cannot be made, it answers 400 and closes the cell's port instead of hanging.
- af8397e: WebSockets into a loaded Worker (Worker Loader) no longer go through the isolate's multiplexed
  port: a 101 answer hands the host the socket's own MessagePort, transferred, so its frames go
  straight to the isolate. One isolate now holds any number of open sockets (it refused the
  1,024th), with lower latency and more throughput (bench/README.md: echo p50 0.14 → 0.10 ms on
  Node and 0.2 → 0.1 ms in Chromium; 64 KiB messages 65 → 192 MB/s on Node, 68 → 114 MB/s in
  Chromium). The isolate's multiplexer allows 4,096 ports at once (for fetches and upgrades in
  flight), as cellb's other port links do; `globalThis.__cellbMaxPorts` overrides it. When a
  runtime closes, each isolate closes its sockets with 1001 before it ends. An upgrade into an
  isolate fails when its port closes without an answer, instead of staying pending.
- 2abcc32: `createWebSocketClass` is `@statewalker/webrun-http-browser`'s client (0.7.1), and the frames a socket's MessagePort carries are that package's: the server end acknowledges the bytes it dispatched (`{ t: "a", n }`) rather than one message per ack. The ends of a `WebSocketPair` stay cellb's, with workerd's semantics. Over cellb's own client, sockets gain a close-handshake timeout (`closeTimeoutMs`, default 5 s: a server that never echoes the close frame ends the socket with 1006 instead of leaving it closing) and sends that keep their order behind a `Blob`. `heartbeatMs: 0` still turns the heartbeat off (the client pings once, announcing a period the server end does not watch), `timers` may still pass only `setInterval`/`clearInterval`, a relative url still resolves against `http://localhost/` where there is no page, and duplicate subprotocols are still refused case-insensitively. One change: `close()` while the socket is still connecting fails it, as WHATWG says — `error`, then `close` with 1006 — where cellb's client sent the given code once connected. The server end keeps the heartbeat period of the client's first ping: the package's client announces a longer one when its page turns hidden, which a closing tab does on its way out.

## 0.2.0

### Minor Changes

- 9f4a14d: **Breaking:** `createProjectSite` moves to its own entry point, `@statewalker/cellb/site`, and `@statewalker/cellb/browser` no longer exports it. Its compiler, `@statewalker/webrun-modules` (with lightningcss-wasm and @jspm/core), `@statewalker/webrun-site-builder` and `@statewalker/webrun-site-host` become optional peer dependencies. A plain install goes from 52 MB to 19 MB on disk (41 MB to 12 MB of files), and an app that imports only `@statewalker/cellb/browser` no longer ships lightningcss-wasm's 16 MB `.wasm`.
  
  Migration, for projects that build a site in the browser: install `@statewalker/webrun-modules` and `@statewalker/webrun-site-builder` (and `@statewalker/webrun-site-host`, which hosts the site in a ServiceWorker) and import `createProjectSite` from `@statewalker/cellb/site` instead of `@statewalker/cellb/browser`.

### Patch Changes

- a76f040: `runtime.close()` shuts down in order instead of closing the databases under running code: it aborts the signal of the requests in flight (the Worker's and its Durable Objects', as when a client goes away on Cloudflare, so long polls and SSE streams end), lets events still running and `waitUntil` work finish within `closeGraceMs` (default 2 s), including the calls they make to other objects (a queue's delivery to its consumer, say), then takes the final backups and closes. A closed runtime answers requests with 503 and opens no cell again (it reopened them on storage that was closed or already another runtime's); an object's code still running fails with `ObjectClosedError` instead of SQLite's "DB has been closed".
- 627ef5f: `parseJsonc` is exported from `@statewalker/cellb`: a browser host that fetches or imports a
  project's `wrangler.jsonc` can read it (comments and trailing commas) as `loadNodeProject` does.
- b423782: Node: code loaded through a Worker Loader binding (`env.LOADER.get(…)`) now runs from the published
  package. Its `cloudflare:workers` module pointed at `cloudflare-workers.ts`, which exists only in
  the sources, so every loaded Worker failed to build with `Could not resolve "./cloudflare-workers.ts"`.
  
  A project runtime's `close()` now ends the isolates of its loaded Workers (a worker thread on Node,
  a Dedicated Worker in a browser). On Node, an isolate's port kept the process alive after `close()`.
- 17b4df3: Depends on `@noble/hashes` 2 (from 1.8).
- c9c1441: partyserver (cloudflare/partykit) runs on cellb unchanged, including Servers loaded at run time
  through a Worker Loader and run as facets, on Node and in browsers:
  
  - A WebSocket upgrade reaches a loaded Worker and its facets: it crosses into the isolate on a
    channel of its own (a fetch crosses as HTTP/1.1, which drops `Upgrade`), and the 101 answer's
    socket is relayed back. In a browser, a facet stub's `fetch` keeps `Upgrade` and
    `Sec-WebSocket-*`, which a copied `Request` drops.
  - A loaded Worker's realm has the Workers globals (`WebSocketPair`, a `Response` that takes
    `{ status: 101, webSocket }`, `Request`, `WebSocket`) as free names, on Node and in browsers.
  - `ctx.facets.get(name, () => ({ class, id }))` gives a facet of loaded code that `id` (its
    `ctx.id.name`, partyserver's `this.name`), as it already did for local classes.
  - Frames a server sends before its 101 response is handed over (partyserver greets the socket in
    `onConnect`) are no longer dropped: `takeClientPort` hands them to the new holder first.
  - Two facets of loaded code given the same `id` keep their own object and storage (the id is
    their `ctx.id` only).
  - An upgrade's port into an isolate closes when the upgrade is refused or fails, and a socket's
    relay closes with its closing handshake; a 204/205/304 answer has no body; an error that
    cannot be copied crosses as its name and message.
  - When a runtime closes, the sockets open into its loaded Workers close with 1001.
- ce02a5f: Cells in SQLite WASM (OPFS pools, LTX files, IndexedDB and in-memory cells) take about half the memory: each connection runs without lookaside, and a new cell database gets 4 KiB pages, celld's page size, instead of SQLite WASM's 8 KiB. A connection with a small table goes from about 258 KiB to about 120 KiB of the worker's SQLite heap (at most 2 GiB), so about twice as many cells can be open in one worker. A database that already holds data keeps its page size.

## 0.1.1

### Patch Changes

- 991f9db: `loadNodeProject` with `nodejs_compat` under plain Node: CommonJS dependencies of a Worker can `require()` Node's built-ins (mime-types requires `node:path`), as under workerd's nodejs_compat. The ES module bundle gets a `require` made with `createRequire`; before, it failed with `Dynamic require of "node:path" is not supported` outside vitest, whose module runner provided one.
