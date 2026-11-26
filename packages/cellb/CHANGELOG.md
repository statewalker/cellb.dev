# @statewalker/cellb

## 0.15.0

### Minor Changes

- d011b1e: "Remove with data" for the fragment hosts (statewalker-root#261): `FragmentHost.remove(id, { withData: true })` deletes `<data>/fragments/<id>/` once the fragment's project is closed, and `joinFragmentShards`' `remove(id, { withData: true })` deletes the fragment's SQLite pool (SQLite WASM's `removeVfs`) and files directory in every shard the tab runs, a disabled fragment's too (not yet isolated Workers' storage, nor the shards other tabs run). On Node, `remove` refuses an id that is not a fragment id when `withData` is set, and an `add` of an id being removed waits for its data to be gone. Added again, the fragment starts from nothing. A plain `remove` keeps the data, as before.

## 0.14.0

### Minor Changes

- ee5c4d7: The fragment host in a browser (#191): `joinFragmentShards` (`@statewalker/cellb/tabs` and `/browser`) runs one pool of shard workers shared by the origin's tabs, and `serveFragmentShard` is its worker side. Every worker holds every fragment (each in OPFS pools of its own), fragments are added and removed while it runs, and the ServiceWorker's router sends `<basePath>fragments/<id>/…` to the pool, then to the fragment DO at `idFromName(<id>)` in the shard that owns it. A project's own `cloudflare:workers` `waitUntil` now holds the scope it was loaded with, so several projects share one realm.
- 77ee968: `createFragmentHost` (`@statewalker/cellb/node`): many wrangler projects side by side in one runtime, each in a namespace of its own (`<data>/fragments/<id>/`), added and removed while it runs, each reached at `/fragments/{id}/…` through its fragment DO at `idFromName(<id>)`, with unsupported configuration reported per project (#191). A single-project host's data layout is unchanged.
- 2a6a38a: Service bindings between the projects of a fragment host (#192): `services` naming another fragment gives a working binding (`fetch` and JS RPC) whose call runs where the target's fragment DO is: in the runtime on the same shard, through the router across shards, and over HTTP (`<url>/fragments/{id}/`, `/peers/{peerId}/fragments/{id}/`) on another host by the route table (`createFragmentHost({ routes, remote, peerId })`, `joinFragmentShards({ routes, peers })`, `FragmentHost.serveLink`). Only structured-cloneable values and one stream per call cross, in every placement, and a function, stub or `Request` fails with a `DataCloneError` naming the call; a call while the target or the caller is not active fails at once with `ServiceUnavailableError`. `ProjectHost.services` / `LoadProjectOptions.services` take a `ServiceResolver` for other hosts.
- a94c59d: Fragment states and the host's own peer path (statewalker-root#259): `FragmentHost.disable`/`enable`/`state` on Node and `joinFragmentShards`' `disable`/`enable`/`state` in browsers keep a fragment known while it is stopped. A disabled fragment answers 503 and an unknown one 404 without waking a DO; in a browser the ServiceWorker's router answers both itself, from the fragment table the tabs tell it. `/peers/{peerId}/fragments/{id}/…` with the host's own `peerId` (`createFragmentHost({ peerId })`, `joinFragmentShards({ peerId })`) answers as `/fragments/{id}/…`.

### Patch Changes

- 9c798a0: The fragment host's default entry is the project's one declared Durable Object binding even when it also has D1, KV, queues or workflows (the runtime's hidden bindings are never an entry), and conformance runs celld's examples side by side in one fragment host (#191).

## 0.13.1

### Patch Changes

- 52e0b35: Under ownership (a fleet), a cell's container lives with the node's lease on the cell (#225). A node that loses the cell while it keeps running (its lease fenced after a pause or a partition) destroys the cell's container at once, and one that gives the cell back destroys it before the release; before, the container stayed until its inactivity timeout (10 minutes by default) while the new owner ran one of its own. A cell that stays on its node keeps its container across its object's instances, as before.
- 3d555af: A cellb follower in celld's log tier answers an append without waiting for the files the bucket already holds to be deleted (#228). Nearly every append carries celld's truncation watermark; the follower listed its directory and deleted the segments below it before replying, and those deletes also took the threads of Node's pool that the next write needed. Under load the appends ran slow enough for celld to evict the follower ("gray follower") or to count an append as failed, and its acknowledgements fell back to the bucket. The deletes now run after the replies, one prune at a time per leader; the base they prune to is on disk first.
  
  Its durable writes (a segment, `state.json`) now run as one synchronous step on a worker thread of their own, as celld's follower writes on a blocking thread: through `fs/promises` each of open, write, fsync, close and the directory's fsync was a trip through Node's 4-thread pool, which the node's other file work fills under load.
- 52e0b35: A fleet node that leaves (SIGTERM, `FleetNode.close()`) answers the requests a client already sent on a kept-alive connection (#222). It dropped its idle connections at once, so a request on its way, sent by a client or load balancer that had not yet seen the node go, was reset (`ECONNRESET`). The node now stops accepting connections, keeps the open ones for 500 ms (within the drain period), and answers each request meanwhile with `Connection: close`.
- 3d555af: A leaving node's peer server answers the calls other nodes already sent on its pooled tunnels. It dropped its idle tunnels at once, so a call routed to it at that moment failed with "socket hang up" (a 500 at the node that routed it). It now stops accepting tunnels, keeps the open ones for 500 ms and answers with `Connection: close`; its cells are released by then, so such a call is told to re-resolve the owner and lands on the next one.

## 0.13.0

### Minor Changes

- 923683f: Fleet nodes run containers. `startFleetNode({ containers })` and `cellb serve --containers MODULE` (`CELLB_CONTAINERS`) give the node a container engine for the project's `containers` classes; the module's default export is the engine or a function that makes one (`loadContainerEngine` from `@statewalker/cellb/node`). A cell's container runs on the node that owns the cell: when the cell moves (its node dies or leaves), the next owner starts the same image (`cellb.containers.<class>`) and runs the same scripts, and the cell's storage goes on. Before, a fleet node reported every `containers` class as unsupported.

### Patch Changes

- bcad763: A cellb follower in celld's log tier keeps its place under load. celld evicts a follower whose appends stay slower than max(4 × its siblings', 25 ms) for 2 s ("gray follower evicted"), and its acknowledgements then fall back to the bucket. cellb's follower fsynced two files per append, a segment and `state.json`, one append at a time, so on a slow disk celld dropped it. As celld's follower does, the appends that arrive while a leader's last write is on its way to disk are now written together, as one segment file headed by the fragment's range: one file and one directory fsync per burst. `state.json` changes only with the epoch, a seal or a truncation without entries. Segments written by 0.12.0 still load.
- 923683f: A cell of a crashed node answers again once the node's lease has run out (about 10 s). The node taking the cell recovers the dead node's log tier session first, as celld does at the takeover (`ensure_recovered`); before, it waited for a recoverer's sweep, every 30 s, so the cells came back 10 to 40 s after the crash. `celldBucket(…, { recoverDead })` is the hook; `startFleetNode` wires it to its recoverer.

## 0.12.0

### Minor Changes

- bba1530: `ctx.container`: objects of a `containers` class get Cloudflare's container API when the host gives the runtime a container engine (`loadProject(…, { containers })`, `ProjectHost.containers`, `createCellRuntime({ containers })`) and the class has an image under the new `cellb.containers` key of its wrangler config (file references are read when loading and by `cellb build`). One container per cell, kept across the object's instances, destroyed after its inactivity timeout or by `close()`. The engine port and `createContainer` are exported from `@statewalker/cellb/container`. Without an engine or an image, the class is still reported in `unsupported`, now saying which is missing. `enableInternet` is passed to the engine, which decides whether a container may have egress. An image may set `workdir` (the working directory of its entrypoint and `exec()`), and `getTcpPort().fetch()` passes a `Request` through unchanged, so a WebSocket upgrade request (its headers as an own property, as `@statewalker/webrun-http-browser` builds it) reaches the engine intact. A container counts calls still running as activity; a `destroy()` during `start()` destroys what the start brings up; a closing runtime starts none and destroys them after its grace period. File references must stay inside the project and name UTF-8 text files.
- dd97c20: Mixed celld + cellb fleets on one bucket (#208): requests for a cell another node owns now reach that node however they arrive. Events queued on a node whose claim of the cell failed are sent to the owner instead of failing with `ObjectClosedError`; a newer host for the cell is no longer closed by an older request's reroute; when the owner's lease runs out between the failed claim and the owner lookup, the cell is claimed locally, as celld does. An owner that cannot be reached (its process died while its node lease is live) is reported as celld reports it: `DurableObjectRoutingError: The Durable Object owner is currently unreachable` (exported), instead of the socket's error. `celldBucket(...).advertise()` re-arms the lease deadline, so a node whose renewals stop after an advertise still fences its cells (#178). A peer server (and `celldPeers`) on a bucket without the fleet's peer secret creates `fleet/peer-auth.json`, as celld's first node does, instead of refusing to start: a fleet of cellb nodes only, or one a cellb node joins first, routes between its nodes.
  
  `cellb serve [project] --bucket s3://NAME[/PREFIX] [--endpoint URL] [--listen IP:PORT] [--internal-listen IP:PORT] [--advertise ADDR:PORT] [--node NAME]` runs a project as a node of a celld fleet, with celld's flags and environment (`CELLD_BUCKET`, `S3_ENDPOINT`, `AWS_*`): the cells in the bucket under celld's ownership records, celld's peer tunnel on the internal listener, the Worker (WebSockets included) on the public one. SIGTERM releases the node's cells. The same node is `startFleetNode()` from `@statewalker/cellb/node`.
  
  **Data loss fixed: celld's takeover recovery gate.** In celld's default `CELLD_DURABILITY=fleet`, a celld node acknowledges writes its followers hold before they reach the cell's prefix in the bucket. cellb took a cell from a dead celld node as soon as its lease expired and restored a stale generation, losing acknowledged writes. `celldBucket` now takes such a cell only once that node's log is recovered (`log.state` in `nodes/<node>.json` is `sealed`, or there is no `log`), as celld does; until then requests answer `DurableObjectRoutingError`, and a running celld node recovers the log.
  
  A leaving node (SIGTERM, `FleetNode.close()`) drains its requests in flight, releases its cells while its peer server still answers (a request routed to it meanwhile is told to re-resolve), then stops; open peer tunnels no longer keep `startCelldPeerServer(...).close()` from finishing. A request whose owner left between the lookup and the call claims the cell where it is.
  
  `cellb serve` runs AsyncLocalStorage on AsyncContextFrame: on Node 22 it relaunches itself with `--experimental-async-context-frame` (the default from Node 24) unless `execArgv` or `NODE_OPTIONS` names that flag either way, and its ready line says which (`AsyncLocalStorage: frame`). On async_hooks every promise paid for it, and a node served 2.7 times fewer requests. The relaunched process exits when its parent dies, SIGKILL included. Fleet nodes log pages with `pageCapture`. `s3ObjectStore` derives the SigV4 signing key once per day, region and secret instead of per request, and hashes with `@noble/hashes` instead of WebCrypto's digest.
  
  Routing between nodes is cheaper: `celldPeers` reuses idle peer tunnels (h1 keep-alive inside, as celld does) and the peer server keeps tunnels open for the next call, from celld or cellb; a node remembers where it last reached a cell and calls that owner directly (a non-owner used to open and delete a local database for every routed call), forgetting the route when the owner answers stale-owner, has closed the cell, or cannot be reached.
  
  
  **cellb as a follower in celld's log tier.** celld recruits followers among every live node, a cellb node included; cellb answered 404, celld quarantined it and fell back to bucket acknowledgements. `cellb serve` now serves `/peer/log/append`, `/seal` and `/tail` (`createLogFollower`, `startCelldPeerServer({ follower })`): it holds the leaders' LTX segments on disk (`--data`), so celld acknowledges on it, and hands them to the node that recovers a dead leader. A node with a peer server reports memory headroom in its node record, which celld's first-readiness gate requires: a celld node started while a cellb node was live never became ready.
  
  A call is sent to another node only when it never started: `ObjectClosedError` carries `notStarted`, and only such a closure answers stale-owner (a call its node closed while it ran may have written). Calls forwarded to a node are served there or answered stale-owner, never forwarded again (`CellRuntime.localNamespace(binding)`), and a node that holds a cell open serves it whatever route it remembered. `cellb serve` keeps its signal handlers while it leaves the fleet, so a signal that reaches it twice (process group and relaunching parent) no longer kills it half way.
- b457835: cellb leads and recovers sessions of celld's log tier, as a celld node does (#209). `cellb serve` (`startFleetNode`) leads unless `--durability bucket` (`CELLD_DURABILITY`): its commits are acknowledged once its followers (celld or cellb nodes) hold their LTX segments, or once the bucket does, whichever is first, with uploads kept in TXID order. Every node recovers the session of a dead leader, celld's or cellb's (claim, seal and tail the followers, upload what the bucket lacks, seal), unless it left celld node bundles. The node record is written by compare-and-swap and carries the session (`log`); a node that published one keeps its record, expired and sealed, when it closes. New exports from `@statewalker/cellb/node`: `createLogLeader`, `createLogRecoverer`, `createLogFollower`; `celldBucket(...).setShipper()`, `.setLog()`, `.session()`, `.flush()`.
  
  A route to a cell's owner stays while calls keep reaching the owner through it (`routeTtlMs`, default 60 s since the last use): a node no longer opens and deletes a local database for every remote cell once a minute (#210). A log tier leader sends everything queued for a follower in one append.
- 9596497: `@statewalker/cellb/node` exports `startProjectShards({ shards, dir, data?, files? })`: one wrangler project over several worker threads, as `/browser`'s `startProjectShards` runs one over workers (#186). Each thread runs `loadNodeProject` and owns the cells `shardOf(id, shards)` gives it; a port links every two threads, so a Durable Object call from any thread runs in the owner's, and ingress goes round robin. Thread `i` keeps its files in `<data>/s<i>` (memory without `data`). With `files`, the cells' LTX log goes to that FilesApi, served from the main thread, and each run restores the cells from it into temporary files, so a later run with another number of threads opens them where the last one left them. Without `files`, the cells live in `data`, which keeps the thread count it was made with and refuses another.
- cd03016: `startProjectShards({ bucket })` also takes a function, `(shard) => BrowserBucket`, so that each shard can get its own bucket (#185). This lets shards keep their cells on the page's own FilesApi (a folder, S3, memory): `{ ltx, node, files: { port: filesApiPort(files).port } }` per shard. The MessagePorts in a shard's bucket (`files: { port }`, `ltxStore.port`) are transferred with that shard's init. Before, a function was spread as if it were an object, and the shards silently ran on their own OPFS pools.
  
  More than one shard on one `ltx` storage now works. Each runtime's own databases (`__cellb/alarms`, `__cellb/cron`) are kept as `__cellb/s<shard>/…`, through the new `ownDatabasesScope` option of `browserProjectRuntime`, which `startProjectShards` and `joinProjectShards` set. Before, the second shard waited 20 s on the first one's lock on `__cellb/alarms` and failed. A single runtime keeps the plain names.

### Patch Changes

- b457835: A fleet node's lease deadline timer that fires before the lease's clock reaches the deadline (timers round) is armed again for the rest, instead of leaving the node without a deadline while its renewals are stuck: such a node kept its cells past its lease's validity (statewalker/cellb.dev#212).
- 8bc1ff6: `dispose()` of a loaded Worker ends its isolate (#206), as in workerd: the worker thread on Node, or the Dedicated Worker in a browser, is terminated at once, so a Worker that never yields stops too, and its calls in flight reject with `loaded Worker "<id>" was disposed`. Before, `dispose()` only dropped the id from the cache: every `env.LOADER.load()` left its thread running until the runtime closed, and a runaway Worker could not be stopped. A disposed `load()` handle now refuses later calls; after a `get(id)` handle is disposed, the next `get(id)` loads the code again, as before.
- 6af4ca0: A browser worker's memory no longer grows with the data its cells write (#184). The SQLite WASM page hook kept a copy of every page a cell wrote until a log took them, but storage that takes no pages never did: an OPFS pool without a bucket, a backup, or a changeset log. A commit now drops those pages, and the runtime's own `__cellb/` databases get no page hook. In Chromium, one page whose 4 workers wrote 6 GiB stays at about 1.7 GB of renderer memory, against 8.3 GB before. `WasmSqliteDriver` takes a fifth argument, `{ pageHook: false }`, for a database whose pages no log takes.
- 875fde1: Faster writes in browsers when a cell's storage takes no pages, such as an OPFS pool without a bucket (#194). The SQLite WASM page hook copied every write, and the commit then dropped the copy. The object host now tells the driver whether its storage takes pages, through a new optional `recordPages(on)` on `SyncSqlDriver`, and the hook records nothing when it does not. With 4 workers, writes went from about 181 to about 225 MB/s. A log or bucket still takes every page as before.
- 6c6a13e: Browser loader: a literal `import("./x.js")` of a module the loaded Worker does not have fails when it runs ("No such module"), as on workerd and on Node, instead of failing the whole load. Kitesurf's page runtime imports its classic-script module this way and has it only for pages with `<script>` tags, so pages without scripts could not be opened in a browser.

## 0.11.1

### Patch Changes

- aab4dda: A node whose cells were fenced (a lease renewal that failed or landed after the local deadline) takes its cells again on their next event, at the next epoch. The fenced object's lease release no longer races the new object's claim on `own.json`, which refused the cell as "owned by another node" and left it released for celld to take. Every lapse fences the cells holding the current fence, so a cell taken again is fenced by the next lapse; a node claims no cell while its lease has lapsed; and the node keeps renewing after a failed renewal instead of stopping for good.

## 0.11.0

### Minor Changes

- bf5a11b: Moves to webrun-wire's current lines (statewalker/statewalker-root#69): `@statewalker/webrun-rpc`
  ^0.11.0 -> ^0.15.0, `@statewalker/webrun-streams` ^0.3.0 -> ^0.6.0,
  `@statewalker/webrun-http-streams` ^0.5.0 -> ^0.8.0 and `@statewalker/webrun-http-browser`
  ^0.13.0 -> ^0.17.0; the optional peer `@statewalker/webrun-site-host` ^0.4.0 -> ^0.6.0. These are
  breaking lines: webrun-rpc's port wire changed across them, so a page hosting sites with cellb
  must serve the ServiceWorker script (`/sw-worker.js`) from `@statewalker/webrun-http-browser`
  0.17 too. No API change in cellb. An error a loaded Worker's `fetch` throws in its isolate still
  reaches the caller with the stack where it was thrown (webrun-http-streams 0.6 leaves it out of
  its error header unless asked); an error of the host's `globalOutbound` Fetcher now reaches the
  loaded code without the host's stack.

## 0.10.0

### Minor Changes

- cf34cc4: **Move to `@statewalker/webrun-files` 0.12, with the webrun-sites releases built on it.** The dependency ranges move:
  - webrun-files, -browser, -mem and -node go to ^0.12.0;
  - the optional peers move to webrun-bundler ^0.2.0, webrun-modules ^0.4.0, webrun-site-builder ^0.3.0 and webrun-site-host ^0.4.0.
  
  These are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` above the root. Consumers must use the same lines, so a single copy of the webrun-files core is installed. webrun-site-builder 0.3 uses the global `URLPattern` (Node 24 or newer, or a browser).

## 0.9.2

### Patch Changes

- d3aa0a5: `installProjectRouter(self)` typechecks with TypeScript's WebWorker lib: `ServiceWorkerScope.addEventListener` takes a listener of `Event` instead of `never`, which a real `ServiceWorkerGlobalScope` was not assignable to.

## 0.9.1

### Patch Changes

- ea06919: Follow-ups to the Worker Loader changes of 0.8.9:
  
  - In a browser isolate, an `import()` in code the loaded Worker builds with `Function` (or `AsyncFunction` and the generator constructors) resolves against its modules, as on Node and workerd: the isolate's function constructors route it. Kitesurf imports page modules this way; before, such an `import()` resolved against the isolate worker's URL.
  - A `Response.error()` returned across an isolate arrives as an error response (status 0) instead of failing the call; a response with a status the `Response` constructor refuses arrives without a body, still reporting its status.
  - Loading code finds a module's import() calls and its export names in one parse instead of two (a CommonJS module still has its own scan).

## 0.9.0

### Minor Changes

- 7f21ad8: A project loaded in a browser has `exportCells()`: the cells' databases from its OPFS pool, as `[file name, bytes]`. The names are the ones `nodeSqliteOpener(dir)` gives the same cells, so a data directory on Node (`loadProject(dir, { data })`) starts where the browser's cells are. A project whose cells are not in a pool (a bucket) returns none.

### Patch Changes

- 3fa2705: node:sqlite on Node 22: a zero-length BLOB is stored as a BLOB, not as NULL. Node 22 binds a view whose buffer has no backing store (`new ArrayBuffer(0)`, or a `Uint8Array` made from one) as NULL, so `sql.exec("INSERT … VALUES (?)", new ArrayBuffer(0))` stored NULL where workerd stores an empty BLOB, and the sqlite object store (celld dev's bucket) refused an empty object (`NOT NULL constraint failed: objects.body`). Zero-length bytes are now bound as an empty view over a real buffer. SQLite WASM was not affected.
- e4354f8: Alarms and cron triggers more than about 24.8 days ahead now fire once, when they are due. setTimeout takes at most 2^31 − 1 ms and fires any longer delay after 1 ms. Before this fix:
  
  - An alarm set further ahead fired at once, found itself not yet due, re-armed, and woke its object every millisecond. celld's workflows set 30-day alarms.
  - A cron trigger whose occurrences are further apart than that ran its `scheduled()` handler at once, then ran each following occurrence about every millisecond, each with a future `scheduledTime`. This covers any monthly or yearly trigger.
  
  Both now wait in steps of at most 2^31 − 1 ms.

## 0.8.9

### Patch Changes

- 6bdec16: cellb now depends on webrun-rpc 0.11, webrun-streams 0.3, webrun-http-streams 0.5 and webrun-http-browser 0.13. cellb's API and its messages on the wire are unchanged.
  
  - **HTTP over a port, through webrun-http-streams:** a response body that is idle when its exchange is torn down is cancelled at once, with the abort's reason. Examples are an SSE stream between events or a long poll. Before, it was cancelled only when its next chunk arrived. A handler waiting on its request body fails at once, and an upload is cancelled as soon as its request's signal aborts.
  - **Windowed HTTP links:** from a link's second exchange on, a request's body goes out before the peer's ack instead of waiting a round trip for it (webrun-rpc's `presumeAck`). The isolate links have no window and are unaffected.
  - **Ports closed before a stream starts:** a stream on such a port now fails at once instead of waiting.
- a5ce11c: Worker Loader and Workers behaviours of workerd that CellB lacked (found running Cloudflare's Kitesurf browser engine Worker on CellB):
  
  - A class as the default export (`export default class extends WorkerEntrypoint`) answers `fetch`, `scheduled` and `queue` with an instance per event, built with `(ctx, env)`; the static assets router passes it the requests the assets do not answer. Before, such a Worker answered "Worker has no fetch handler", and with assets every miss was a 404.
  - A wasm import (`CompiledWasm` rule) is compiled synchronously, as workerd imports one. Its top-level `await WebAssembly.compile` made every importer async, and with circular imports and a dynamic `import()` esbuild's async module inits waited on each other: `loadProject` never settled.
  - Worker Loader `{ cjs }` modules: not in strict mode unless they say so, `this` is `module.exports`, and an import gives `module.exports` as the default export. Before, the module was `undefined`.
  - `abortIsolate(reason)` of `cloudflare:workers`: in a loaded Worker's isolate, the call and the calls in flight reject with `internal error; reference = …`, the isolate ends, and the next `get()` of its id loads the code again (workerd's `abortIsolateDynamic` test). Before, code importing it did not build.
  - `stub.dup()` on stubs that cross into an isolate gives another stub of the same value, released on its own; on Durable Object stubs, service and loaded-Worker entrypoint stubs in one realm, it gives the stub. Before, `dup` was sent as a remote method call. (A function or `RpcTarget` passed within one realm is still the value itself, with no `dup`.)
  - `Request`, `Response`, `Headers` and `ReadableStream` values cross an isolate in arguments and results, as on workerd; bodies stream over a port of their own when read, and a body cancelled unread is cancelled on the sending side. Before, they failed with `DataCloneError`. In one realm, a call passes a Request, Response or stream itself and copies Headers.
  - A loaded Worker's isolate lets its code assign `navigator` (Node's and a Dedicated Worker's are getters).
  - `Uint8Array.prototype.toBase64`/`toHex` and `Uint8Array.fromBase64`/`fromHex` where the engine lacks them (Node 22).
  - workerd's read-only `/bundle` in `node:fs` (nodejs_compat), on Node and in browser bundles: each `.wasm`, Text or Data module a bundle imports, named `<sha1>-<file name>` as wrangler uploads it (`readdirSync`, `readFileSync`, `statSync`, `existsSync`, `accessSync`, their callback forms and `promises`). On Node every other path is still the real file system.
  - Worker code's `Request` takes a streamed body without `duplex: "half"`, as workerd does (Node's `Request` refuses one without it); the outbound `fetch()` of a loaded Worker builds its requests with it.
  - `import()` in a loaded Worker resolves against its own modules, as on workerd: a module's whole name (a URL, say) or a path relative to the importer, also when computed at run time (Node and the browser loader). On Node, an `import()` in code built with `Function` resolves too, through module hooks in the isolate thread (`module.registerHooks`, Node 22.15 and later). Before, such specifiers went to the host's own loader and failed.
  - `withUpgrade` is exported from `@statewalker/cellb`: in a browser `new Request()` drops `Upgrade` and `Sec-WebSocket-*`, so an embedder that hands a project a WebSocket from a page (a project in a Dedicated Worker) had no public way to make the upgrade request.
  - A browser isolate keeps its channel to the host when the loaded code replaces the global `postMessage` (a page emulation such as Kitesurf's window does): the isolate worker takes its own `postMessage` and listeners before the code runs. Before, every later answer went into the code's own `postMessage` and the host waited forever.
  - An import in loaded code that names none of its modules (a missing sibling, a package) no longer fails the whole load: it becomes a module that throws when it is evaluated, as on workerd, so an unused module may import anything, and a CommonJS `require()` of something absent throws where it is called (`try { require("optional") } catch {}` works). A static import of a module's whole name (a URL) resolves to it.

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
