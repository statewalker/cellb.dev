# @statewalker/cellb

## 0.8.8

### Patch Changes

- 2292f58: node:sqlite driver: `restore()` loads the extensions loaded before (e.g. a cell's `sqlExtensions` such as `sqlite_vec`) into the new connection. A cell restored from a backup lost them: its first `vec_version()` failed with "no such function". SQL still cannot load a library by itself after a restore.
  
  An in-memory driver's `restore()` makes a directory for the database file; `close()` (or process exit) now removes it, where it was left in the temp directory. A connection whose extensions fail to load is closed before the error is thrown.

## 0.8.7

### Patch Changes

- Release of the changes since the last published version:
  
  - exports changed

## 0.8.6

### Patch Changes

- 3a64eff: While an async `ctx.storage.transaction()` is open, async storage writes from another event (`put`, `delete`, `deleteAll`, `setAlarm`, `deleteAlarm`) wait until it ends, as that event would on workerd. Before, they ran inside the transaction's savepoint, and its rollback undid them. Reads don't wait, so a transaction can still await a read another event started. A synchronous write from another event (`sql.exec`, `kv.put`) cannot wait; CellB warns about it once per object. Events are told apart through async context (Node, or engines with `AsyncContext`); elsewhere nothing changes.

## 0.8.5

### Patch Changes

- b97e764: On a celld bucket, commits are logged from the WAL also for cells without a data directory. `nodeSqliteOpener(undefined, { pageCapture: true })` keeps each cell in a temporary file (not synced, removed when the cell closes or the process exits), so its commits' pages are read from the WAL instead of imaging and diffing the whole database per commit. `loadProject` on Node turns page capture on when its storage logs pages, and Node isolates' facets use it too. The runtime's own databases are never page-captured, and a captured database whose pages nobody reads keeps its WAL bounded.
- 487d52c: An object's async `ctx.storage.transaction()` calls now run one after another, as on workerd. Before, two calls that had both passed the input gate could overlap. Each opened the same savepoint, so when one rolled back it also undid the other's writes.
  
  D1 hit this. Miniflare's D1 object reads each request's body before it starts the request's transaction, so concurrent queries overlapped. EmDash 1.5's first start then failed with `no such table: _emdash_migrations_lock`: a failing read rolled back the `CREATE TABLE` that a concurrent migration had just run.
  
  A `transaction()` awaited inside another transaction's closure nests, as on workerd, wherever async context is available (Node, and engines with `AsyncContext`). Elsewhere, in most browsers today, such a call waits forever: use the closure's `txn` argument there.

## 0.8.4

### Patch Changes

- a4d8821: Only `nodejs_compat` and `nodejs_compat_v2` turn on Node.js compatibility, as in workerd and Wrangler. Before, any flag starting with `nodejs_compat` did, so a project with only `nodejs_compat_populate_process_env` got the Node.js modules and a filled `process.env` that workerd would not give it.

## 0.8.3

### Patch Changes

- 44a9e41: A project with `nodejs_compat_populate_process_env` or `nodejs_compat_do_not_populate_process_env` is no longer told these flags are unsupported: every host already honours them when it fills `process.env`.
- 52392b2: A browser runtime's OPFS pool (`sahpoolOpener`, used by `browserProjectRuntime`) grows ahead of its cells instead of once it is full. Each new slot is an OPFS file with a sync access handle, made one at a time, and in a busy worker each one takes seconds, about 5 s with 32 Flue conversations in one worker. Before, the pool counted only the files that already existed, so it did not see the journals open cells were about to create. Its background growth ran from a microtask that ran late under load. And a cell that found the pool full waited for it to double (64 more handles, minutes), which looked like a hang: 32 conversations in one worker stalled. Now an open cell counts its journal until it has one; every open (a failed one too) starts the background growth, which keeps two thirds of the pool free; a growth step asks for its 16 slots in parallel (about one slot's wait instead of sixteen); and a cell waiting for room waits for what was needed when it asked, not for later reservations.

## 0.8.2

### Patch Changes

- 4ad45bc: `hostSitesForWorker` and `siteCompiler`'s default host work on pages served over https. A request reaches the page's handler through webrun-http-browser, which before 0.12.5 rebuilt its url as `http://<host>/…`. The site's handler is registered under the page's own URL (`https://<host>/…/`), so on an https page no request reached it: every one answered "404 Error 404: Not found" (over http nothing showed). cellb is now on `@statewalker/webrun-http-browser` ^0.12.5, which rebuilds the url at the page's scheme, and `HostedSiteBuilder`'s page side (`SwHttpAdapter`) now comes from cellb's own webrun-http-browser. Before, it came from the ^0.7 copy that webrun-site-host depends on. cellb's copy is the version whose ServiceWorker hosts serve, and the one with the fix.

## 0.8.1

### Patch Changes

- c7d25a8: The browser Worker Loader rewrote a loaded module's imports (`cloudflare:workers` → its shim, relative paths → sibling Blob URLs) with a regex over the whole text, so the same words inside a string, a template, a comment or a regular expression were rewritten too: a code generator whose template contains `from "cloudflare:workers"` emitted a `blob:` URL. The module is now scanned as code, and only its own `import … from`, `import "…"`, `export … from` and `import(…)` specifiers are rewritten.
- bb9d50d: `lowerAwait` (the fallback that lowers async functions for a browser build with a top-level await, such as a `.wasm` import) passed `arguments` to a lowered async arrow whenever the word appeared in its body, in a string, a comment or a nested function's own `arguments`. In a class field or a static block that is a SyntaxError (`'arguments' is not allowed in class field initializer`), so such a bundle failed to load. An arrow now gets its enclosing function's `arguments` only when it reads them itself.

## 0.8.0

### Minor Changes

- 72fffc5: Smaller browser bundles. A page that joins a project shared by the tabs and its ServiceWorker
  import `joinProjectShards` and `installProjectRouter` from the new `@statewalker/cellb/tabs`
  entry, which holds only the routing code (about 75 KB minified instead of about 280 KB). In a
  shard, the binding implementations a project declares load on demand: `loadProjectBindings(config)`
  imports Miniflare's D1 simulator, celld's KV, queue and workflow code, R2, assets, cron and Worker
  Loaders only for the bindings `wrangler.json` names, and the HTMLRewriter glue loads on first use.
  The counter demo's shard worker goes from 759 KB to 488 KB, 214 KB of which is SQLite's own JS.
  
  `createProjectRuntime(config, module, host)` now takes these implementations in
  `host.bindings` (`bindings: await loadProjectBindings(config)`); a config that declares a binding
  the host did not load is refused with an error saying so. `loadProject`, `browserProjectRuntime`
  and the Node hosts load them themselves.
- 0da6edf: Non-JS imports follow wrangler's module rules: `import mod from "./add.wasm"` (and `./add.wasm?module`) gives a compiled `WebAssembly.Module`, as workerd's `CompiledWasm` rule; `.bin` an `ArrayBuffer` (`Data`); `.txt`, `.html`, `.sql` a string (`Text`). A project's own `rules` (`CompiledWasm`, `Data`, `Text`, with `globs` and `fallthrough`) are honoured. `loadProject` on Node and `cellb build` inline the bytes, so a built `worker.js` stays self-contained for browsers.
  
  A project that already had a rule such as `{ type: "Data", globs: ["**/*.txt"] }` now gets an `ArrayBuffer` for those imports, as on wrangler.

## 0.7.0

### Minor Changes

- b490cdc: `loadProject` in browsers loads a project from its sources, with a `compile` option (#72):
  `bundleCompiler` (new entry `@statewalker/cellb/bundle`: webrun-bundler on esbuild-wasm, one ES
  module) or `siteCompiler` (`@statewalker/cellb/site`: modules compiled one by one and served from a
  ServiceWorker; `siteHostOverPort` / `hostSitesForWorker` let a page host a worker's site). Without
  `compile`, only `cellb build` folders load, as before. `@statewalker/webrun-bundler` is a new
  optional peer dependency. Importing the `node:*` polyfills (`@statewalker/cellb/host-modules`) no
  longer fails in a realm without `process`.

### Patch Changes

- b7a0fd4: A request no longer gets copied so that its signal also aborts when the runtime closes. Since 0.2.0 every request to `runtime.fetch` and to a Durable Object's `fetch` was copied with a merged signal (`new Request(req, { signal: AbortSignal.any([...]) })`), about 7 µs each, which halved in-process throughput (about 80,000 → 40,000 requests a second on Node). The request is now handed over as it is, and its `signal` is a getter that merges the two signals the first time it is read: a long poll or an SSE stream that waits on it still ends when the runtime closes, and a handler that never reads it pays nothing. One difference: a copy the handler makes itself (`new Request(req)`, or `fetch(req)` to forward it) takes the request's own signal, without the runtime's.

## 0.6.0

### Minor Changes

- bf63830: Cells on LTX files (`bucket: { ltx }`) can live on any FilesApi the app opens before it starts its shard workers: a folder on the user's disk (File System Access), memory, OPFS, a key/value store, S3. `files` takes `{ port }` (a FilesApi served with `filesApiPort` / `serveFilesApi`, called over `@statewalker/webrun-rpc` from the store worker) or `{ module, args }` (built in the store worker), besides the `"opfs-sync" | "opfs" | "memory"` presets; `ltxStore: { sab, port }` uses a store the app runs itself (`serveLtxStore`, on the page) instead of a store worker. `serveLtxStore` takes a `room` option for the free-space check and its `close()` ends the store's work and releases its Web Locks; a store worker that fails to open its FilesApi now fails the shard's start with the reason (and is terminated).
  
  A compaction now moves its new snapshot into place before it removes the files it replaces. It removed them first, so a compaction cut short between the two steps (a closed tab) left only the `.tmp` snapshot, which the next open deleted, and the cell with it. A cell whose compaction stopped after the move opens from the snapshot, and the files it covers are removed.
  
  Fixes in the LTX store for bugs present in earlier releases:

  - After a compaction's swap, the store reopened the cell outside its request queue, so a commit made meanwhile could be dropped from the reopened view, and the next commit then wrote over its file (that transaction lost). The reopen now happens in the queue.
  - The VFS took any answer in the shared buffer for its current request: the late answer to a request it had given up on (after 30 s) was read as the next request's (wrong pages). Requests are now numbered and answers tagged.
  - A commit the VFS gave up on (SQLite rolled it back) was still written and kept by the store. It is now dropped, whether a newer request has come or the commit finished too close to the VFS's deadline.
  - A snapshot file that does not open (a move done as a copy, cut short) is skipped, so the cell is read from the files it was made from.

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
