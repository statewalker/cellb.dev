# @statewalker/cellb

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
