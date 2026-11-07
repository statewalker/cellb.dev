# @statewalker/cellb

## 0.5.2

### Patch Changes

- 633abd6: Loading `@statewalker/cellb/node` (`loadProject`, `nodeSqliteOpener`, `sqliteObjectStore`) no longer prints Node's "SQLite is an experimental feature" warning. cellb picks `node:sqlite`, not its user, so the warning only added noise on every start. Only that one warning is held back while the module loads; every other warning still prints.
- c08efbd: Depends on `@statewalker/webrun-http-browser` 0.12.2, which counts a WebSocket message's UTF-8 size natively instead of in a JavaScript loop. Both ends of every socket count each message, and the loop held 64 KiB echoes into a loaded Worker at about 75 MB/s on Node. With 0.12.2 (bench/README.md): 64 KiB messages 227 MB/s on Node and 132 MB/s in Chromium, 1 KiB messages 32,665 and 15,917 per second, echo p50 0.09 ms and 0.1 ms.

## 0.5.1

### Patch Changes

- Release of the changes since the last published version:
  
  - exports changed

## 0.5.0

### Minor Changes

- 0ce1778: `loadProject(source, options)` in both `@statewalker/cellb/node` and `@statewalker/cellb/browser` (#67): the same name and options (`data`, `bucket`, `ai`, and in browsers `sqlite3` and `isolateScript`), returning `{ config, runtime, unsupported, fetch, close }`. Node loads a wrangler folder (bundled with esbuild, as `loadNodeProject`), a built folder, or a FilesApi holding either; a browser loads a built folder by URL or from a FilesApi, starting SQLite WASM, the OPFS pool (`<data>`), the files directory (`<data>-files`) and the package's own isolate worker itself. The new `cellb build <dir> --out <folder>` command (and `buildProject`) writes that folder: `wrangler.json`, `worker.js` (bundled for browsers), `assets/` and a `cellb.json` manifest. `browserProjectRuntime`'s `isolateScript` also takes a function that starts the Dedicated Worker. `loadNodeProject` and `browserProjectRuntime` stay as the lower-level calls.

### Patch Changes

- 1d11898: When a runtime closes, every socket into a loaded Worker's isolate hears 1001 at once, including those whose server end the Worker never accepted. Before, such a socket's client learned only through the heartbeat (1006, after about 20 s). A 101 from an isolate now carries the frames its server sent before the response was handed over (partyserver greets in `onConnect`), and the host's end replays them, so the socket's own port goes to the client and no relay stays in the isolate for the socket's life.

## 0.4.0

### Minor Changes

- bfa1873: The router of a project shared by tabs (`installProjectRouter` / `joinProjectShards` / `serveProjectShard`) now runs on webrun-http-browser's ServiceWorker dispatcher. The ServiceWorker no longer keeps a `CellRouter` per project. A tab attaches its shard workers with the package's adapter; a shard serves with `serveHttpInWorker` and reaches the other shards through `http://cellb.internal/<project>/`. Re-linking after a ServiceWorker restart, owner liveness, wake, keep-alive and drain on hand-over are the package's.
  
  What cellb adds is unchanged:
  
  - the project urls: `basePath`, a root project with `passthrough` and the host page, and `stripBase`;
  - the page's cookies in and the Worker's `Set-Cookie` out;
  - no `x-cellb*` control headers from pages, on fetches or sockets;
  - calls between shards routed to the shard that owns the object, failing with `ShardOwnerLostError` when its owner is lost.
  
  `installProjectRouter` returns `{ dispatcher }` instead of `{ routers }`. Nothing read `routers`.
  
  A request to a project that no tab has ever served now goes to the network, as the page sent it. Before, it waited for a shard for up to 15 s, then answered 503. A root project's host page still covers navigations no tab serves. A project whose tabs have all closed still answers 503.
  
  The ServiceWorker that runs `installProjectRouter` now calls `skipWaiting()` on install and `clients.claim()` on activate (webrun-http-browser's dispatcher does), so a new version takes over open pages at once. A tab must be controlled by it to join: `joinProjectShards` asks the worker to claim the page and rejects with a `ServiceWorkerControlError` if that fails within 30 s. It now uses the given worker's registration, so a page outside the worker's scope fails with that error rather than waiting forever.
  
  `CellRouter`, `createShardWorker` and `shardRouting` stay, for hosts other than a ServiceWorker (Node).
  
  A root project under Vite's dev server needs Vite's own paths (`/@fs/`, `/@vite/`, `/node_modules/`…) in `passthrough`, because a controlled shard worker's module imports reach the ServiceWorker too. That was already the case.
- 171a61f: The ends of a `WebSocketPair` are webrun-http-browser's `ServerWebSocket`, configured for workerd's semantics: either end may `send()` before `accept()`, a close without a code reports 1005, the heartbeat watch starts with the first ping, a closing end still delivers messages, and `goAway()` closes with 1001. The frame protocol over the MessagePort is the package's, so a page's `WebSocket` and a shard's socket speak the same protocol as any other webrun-http-browser server. The public API of `WebSocketPair` and its ends does not change.

### Patch Changes

- e0d29c2: A bucket's `close()` waits for a lease renewal that is already on its way to the bucket before it removes the node's lease record, and starts no renewal after. Before, such a renewal could write the record back after the delete, so the node's cells stayed "owned by a live node" until the lease ran out (10 s by default) and the next node could not take them over. The browser partyserver test now restarts on the default lease with no wait, where it used a 1 s lease that made it fence itself under load.

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
