# @statewalker/cellb-containers

Containers for cellb in browsers and in Node: Cloudflare's `ctx.container` API, as celld runs it
with Docker, backed here by two engines, [Wasmer](https://docs.wasmer.io/runtime/js/) WASIX
sandboxes and [Lifo](https://lifo.sh). A Durable Object of a `containers` class gets a container
that runs Python, PHP, bash or Node-compatible JavaScript next to it, in a tab or in a Node
process, with no Docker daemon.

**Live demos** (both engines, in your browser): [Python in Wasmer containers](https://cellb.dev/demos/containers/python/)
and [an Observable Framework notebook in Lifo containers](https://containers.cellb.dev/notebook/)
([examples/browser-demos](examples/browser-demos)).

## Two engines: Wasmer and Lifo

Both implement the same `ContainerEngine` port, so `ctx.container`, the pools and FilesApi mounts
work the same on either; each runs in a worker of its own.

| | Wasmer (`wasmerContainerEngine`) | Lifo (`lifoContainerEngine`, `/lifo`) |
| --- | --- | --- |
| What it is | WASIX sandboxes ([`@wasmer/sdk`](https://docs.wasmer.io/runtime/js/)) | a Linux-like OS in TypeScript ([`@lifo-sh/core`](https://lifo.sh)) |
| What runs | WASIX packages from the Wasmer registry: Python, PHP, bash, `wasmer/quickjs`, Node-compatible JS (`wasmer/edgejs`, needs JSPI), your own Rust or C | its shell and commands, Node-compatible JS (`node`, `npm`) |
| Isolation | **a sandbox**: no system calls outside WASIX, no access to the page's or the process's JavaScript | **not a sandbox**: guest JS runs in the worker's realm; for code you trust |
| Network | none (or the host's, for a build step, in Node: `egress: "host"`) | none unless `egress: "host"` and `enableInternet` (through the worker's `fetch`: the page's network in a browser) |
| Files | FilesApi mounts (asynchronous host-filesystem bridge) | FilesApi mounts (synchronous client, `Atomics.wait`) |
| Start | ~0.2 s for Python with its worker warm; 0.8–1.5 s for a new worker | ~0.1 s |
| Memory | ~265 MB per Python container in its own worker | ~31 MB per box in its own worker |
| WebSockets into it | — | `getTcpPort().fetch()` upgrades, `containerWebSocket()` |
| Tested in | Node and Chromium | Node and Chromium |
| Demo | [Python in Wasmer containers](https://cellb.dev/demos/containers/python/) | [a notebook in Lifo containers](https://containers.cellb.dev/notebook/) |

Use Wasmer for code you do not trust and for WASIX software (Python, PHP); use Lifo for your own
JavaScript tooling (`npm install`, build steps, a dev server such as Observable Framework's).

Status: experimental. `ctx.container` is built into cellb: give `loadProject` an engine from this
package and objects of a `containers` class with an image under `cellb.containers` get their
container ([cellb in practice](#cellb-in-practice)). It runs on `@wasmer/sdk` 0.19.1 (alpha) with a
small patch, and on [Lifo](https://lifo.sh).

It is an engine beside celld's Docker, not a replacement: only software compiled to WASI/WASIX
runs. The same class runs on celld with its Dockerfile; the python, php and node examples ship
both.

## What is in the package

| Module | What it does |
| --- | --- |
| `engine` | The `ContainerEngine` port and `wasmerContainerEngine(wasmer)`: containers with or without a main process, no egress, a localhost of their own, host mounts, `exec`, `spawn` with streamed stdio, `close()` destroying every container |
| `container` | `createContainer(engine, image)` (re-exported from `@statewalker/cellb/container`, where `ctx.container` lives): Cloudflare's API (`start`, `running`, `monitor`, `destroy`, `signal`, `exec`, `getTcpPort(p).fetch()` / `.connect()`, `setInactivityTimeout`), plus `waitForPort`, `spawn`. `provideContainerEngine()` / `containerFor()` for objects outside a runtime with an engine |
| `rpc` | `serveEngine(port, engine)` / `connectEngine(port)`: the engine in a worker, the cells holding a proxy with the same interface |
| `files` | `FilesVolume`: Wasmer's host-filesystem protocol served by any `FilesApi`. `HostMounts` (`add`, `reserve`, `bind`, `remove`), `installHostFiles`, `forwardHostFiles`, `serveHostFiles`: route a guest's filesystem calls to the thread that owns the FilesApi |
| `pool` | `createContainerPool(engine, mounts, { image, size })`: runs custom code, each run in a fresh sandbox with its own FilesApi, env and timeout. `provideContainerPool()` / `containerPool()` reach it from Durable Objects |
| `recycle` | `recyclableEngine(spawn)`: an engine whose instance (a Wasmer client in a worker of its own) is replaced when a guest will not stop |
| `isolated-pool` | `createIsolatedPool({ spawn, image, size })`: one worker per container, prepared ahead of time and terminated after use; `acquire()` returns `ctx.container`'s API, `run()` a one-call form |
| `warm-pool` | `WarmPool<T>`: a dependency-free pool of single-use instances (keeps N ready, replaces on take, queues with timeouts, backs off) |
| `worker` | `serveContainerWorker(endpoint, makeEngine)`: any engine served from a worker; `wasmerWorkerEngine(wasmer, files)` |
| `lifo` | `lifoContainerEngine(lifo, { files, egress, webSocket })`: containers on [Lifo](https://lifo.sh) (shell, `npm`, Node-compatible JS) with no network unless `egress: "host"` and `enableInternet`; WebSockets into the box through `getTcpPort().fetch()`; `webSocket`: the WHATWG class the box's own sockets use; `syncHostFiles` mounts a FilesApi through synchronous hooks. For trusted code only: Lifo is not a security boundary (see Isolation) |
| `websocket` | `containerWebSocket(container, port)`: a WHATWG `WebSocket` class whose sockets reach a container's server (an upgrade through `getTcpPort(port).fetch()`, answered with 101 and a `MessagePort`, as in `@statewalker/webrun-http-browser`); the Lifo engine supports it |

```js
import { Wasmer } from "@wasmer/sdk/node"; // or "@wasmer/sdk/browser"
import { createContainer, wasmerContainerEngine } from "@statewalker/cellb-containers";

const engine = wasmerContainerEngine(new Wasmer());
const c = createContainer(engine, {
  packages: ["python/python"],
  files: { "server.py": SERVER },
  entrypoint: ["python", "/workspace/server.py"],
});
await c.start();
await c.waitForPort(8080);
const res = await c.getTcpPort(8080).fetch("http://container/hello");
```

## Examples

The python, php and node examples are cellb projects with the Dockerfile celld would build from
the same source; pool is a cellb project without one, and files is a host script.

| Example | Container | Runs on |
| --- | --- | --- |
| [`examples/python`](examples/python) | A stdlib HTTP server per cell (`python/python`) | Node 22+, Chromium |
| [`examples/php`](examples/php) | PHP's built-in server (`php/php-32`) | Node 22+, Chromium |
| [`examples/node`](examples/node) | A `node:http` server in `wasmer/edgejs`, Node-compatible JavaScript in WASIX | Node 24+, Chromium 137+ (WebAssembly JSPI) |
| [`examples/files`](examples/files) | A host script: a composite FilesApi (read-only, filtered `/input`, writable `/output`) mounted for a Python analysis | Node 22+ |
| [`examples/pool`](examples/pool) | A Durable Object per workspace runs code it is sent on the host's pool, against its own FilesApi | Node 22+, Chromium |

In a project, the object's code is celld's:

```js
export class PyRunner extends DurableObject {
  async fetch(request) {
    const c = this.ctx.container; // celld: Docker; cellb: the engine the host gives it
    if (!c.running) await c.start();
    return c.getTcpPort(8080).fetch(request);
  }
}
```

its `wrangler.jsonc` adds cellb's image next to celld's `containers` entry:

```jsonc
"containers": [{ "class_name": "PyRunner", "image": "./Dockerfile" }],
"cellb": { "containers": { "PyRunner": {
  "packages": ["python/python"],
  "files": { "server.py": "./server.py" },
  "entrypoint": ["python", "/workspace/server.py"]
} } }
```

and the host gives the runtime an engine:

```js
const engine = wasmerContainerEngine(new Wasmer());
const project = await loadProject(dir, { containers: engine });
```

Packages known to run with the SDK 0.19.1: `python/python`, `php/php-32`, `php/php`, `wasmer/bash`,
`wasmer/edgejs` (JSPI). Packages published as zstd-compressed WEBC (`sharrattj/coreutils`,
`wasmer/winterjs`, `sqlite/sqlite`) fail to load with this SDK.

## Running custom code: the pool

A pool runs code it is given (an agent's tool call, a user's script) in containers, each run
against a FilesApi chosen for that run:

```js
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createContainerPool, HostMounts, installHostFiles, wasmerContainerEngine } from "@statewalker/cellb-containers";

const mounts = new HostMounts();
installHostFiles(mounts); // on the engine's thread; or forwardHostFiles(port) to the FilesApis' thread
const pool = createContainerPool(wasmerContainerEngine(new Wasmer()), mounts, {
  image: { packages: ["python/python"] },
  size: 4, // sandboxes kept started, and the most runs at once
});

const files = new MemFilesApi(); // any FilesApi: a composite view, a durable store, ...
const result = await pool.run({
  argv: ["python", "-c", code],
  files, // at /data in the guest, for this run only
  env: { USER_ID: "u-42" },
  timeoutMs: 10_000,
});
// { exitCode, stdout, stderr, timedOut, ms }
```

From a Durable Object, through a pool the host provided by name
([`examples/pool`](examples/pool)):

```js
import { containerPool } from "@statewalker/cellb-containers/pool";

export class Workspace extends DurableObject {
  files = new MemFilesApi(); // this cell's files
  async fetch(request) {
    const result = await containerPool("python").run({
      argv: ["python", "-c", await request.text()],
      files: this.files,
      timeoutMs: 10_000,
    });
    return Response.json(result);
  }
}
```

What a run cannot see, by construction rather than by cleaning up:

- **Another run's guest state.** Every run gets a sandbox nobody used before, started ahead of
  time, and the sandbox is destroyed when the run ends: nothing a run leaves in `/workspace`,
  `/tmp`, its environment or its processes reaches the next run.
- **Another run's files.** A run's FilesApi is bound to its sandbox's mount only while the run
  lasts, through a fresh volume (no host-side buffers carry over), and unbound when it ends.
- Tested: run A writes to `/workspace`, `/tmp` and its FilesApi with `SECRET` in its env; run B,
  with another FilesApi, sees none of it, and neither FilesApi gets the other's files; in
  `examples/pool`, two cells never see each other's files (Node and Chromium).

A warm sandbox costs about 100 MB (Python), so `size` is a memory budget too.

### Isolated pools: one worker per container

`createIsolatedPool` keeps each container in a worker of its own, prepared ahead of time; a request
takes one (or waits for one), and the container is terminated with its worker after use, which
gives its memory back at once and stops anything still running in it. It works with any engine
served from a worker: Wasmer and [Lifo](https://lifo.sh) today, behind one contract test suite.
[Isolated pools](docs/isolated-pools.md) has the measurements, the API and how it maps to
Cloudflare's, the runtimes compared (Wasmer, Lifo, almostnode) and the pool libraries considered.

A container can also run several scripts at once (`slots`): with `isolation: "sandbox"` each script
gets a fresh sandbox in the worker's Wasmer client, verified isolated (its own FilesApi, `/tmp`,
`/workspace`, env), so different callers share workers; with `isolation: "shared"` scripts share a
sandbox and a worker is bound to one capabilities key. QuickJS costs about 20 MB per extra script
and scales to about two scripts per core; Lifo runs one at a time
([Several scripts per container](docs/isolated-pools.md#several-scripts-per-container)).

### Layered files: install once, run read-only

A build container with egress (`wasmerContainerEngine(wasmer, { egress: "host" })` in Node, or
`lifoContainerEngine(lifo, { egress: "host" })` in browsers and Node; trusted steps only) runs
`npm install` into a writable FilesApi; that FilesApi is then a read-only base layer under every
run, each run adding its own writable layer (`CompositeFilesApi`, or `cow` for copy-on-write), as
Docker builds and runs images. [Layered files](docs/layered-files.md).

[Observable Framework](docs/observable-framework.md) installs and builds sites this way in Node
and in Chromium: one build step with egress, then site builds with no network, about 5 to 6 s
each. Its preview runs with live reload, through a WebSocket into the container; the
[notebook demo](examples/browser-demos) edits and previews a notebook in one
browser tab.

### Runaway code

A timeout kills the run. A guest that makes system calls (I/O, `sleep`) stops then. A guest in a
pure compute loop (`while True: pass`) never yields to the runtime: kill() does not reach it, its
thread keeps a Wasmer worker at 100% CPU after its sandbox is destroyed, and `wasmer.close()`
never returns (measured). For untrusted code, give the pool a recyclable engine: the Wasmer client
runs in a worker of its own, and on a timeout the pool replaces it; the old worker is terminated,
runaway thread included, once its other runs end.

```js
const engine = recyclableEngine(() => {
  const worker = new Worker(new URL("./engine-worker.js", import.meta.url)); // serveEngine + forwardHostFiles
  // ...pass it a port for the engine and one for files (serveHostFiles(port, mounts) here)
  return { engine: connectEngine(enginePort), terminate: () => worker.terminate() };
});
const pool = createContainerPool(engine, mounts, { image, size: 4 });
```

Tested: after a runaway loop times out, the process's CPU over the next 2 seconds is back to idle
(under 600 ms, against about 2,000 ms while the loop spins) and the next run is served
(`test/pool-recycle.test.ts`).

## Threads: where each part runs

The Wasmer client's core (package download and compile, the virtual filesystem, the scheduler)
runs on the thread that calls `new Wasmer()`. Each guest thread runs in a Wasmer pool worker.
Sandbox and process objects are bound to the client's thread and cannot be posted elsewhere.

```
 page main thread            cellb node worker              engine worker            Wasmer pool workers
 ─────────────────           ─────────────────              ─────────────            ───────────────────
 UI                          cells (Durable Objects)        new Wasmer()             guest threads
 FilesApi + policy  <──────  ctx.container ──connectEngine──> serveEngine            (python, php, …)
   serveHostFiles     files    = createContainer(proxy)      wasmerContainerEngine    block on Atomics.wait
                      calls                                  installHostFiles(        for each fs call
                                                               forwardHostFiles) <── fs requests (SAB)
```

- Keep `new Wasmer()` off any thread that must stay responsive. Measured with the same Python
  scenario: on the main thread the longest stall was 1,479 ms (Chromium) and 1,530 ms (Node) on the
  first start, 102 to 154 ms later; with the engine in a worker, 13 ms and 27 ms.
- In a browser the engine can live in the node's Dedicated Worker (simplest) or a worker of its own
  (`serveEngine`), and Wasmer's pool workers then start as nested workers.
- In Node, run the engine in a `worker_threads` worker so a container's first start does not stall
  every cell's event loop.

## FilesApi in containers

A container mount (`mounts: [{ path: "/data", id }]`) is served by a FilesApi through Wasmer's
host-filesystem bridge. A guest call travels like this:

1. The guest's WASIX thread, in a pool worker, posts `{ type: "wasmer-filesystem-rpc", mount,
   method, args, response: SharedArrayBuffer }` to the client's thread and blocks on `Atomics.wait`.
2. The client's thread passes it to `globalThis.__wasmerHandleFileSystemRpc`, which
   `installHostFiles(handler)` sets.
3. The handler answers (`HostMounts`) or forwards the message, SharedArrayBuffer included, to a port
   (`forwardHostFiles`) whose other end owns the FilesApi (`serveHostFiles`).
4. Whoever holds the message writes the reply into the SharedArrayBuffer and notifies the guest.

Only the guest's thread blocks, so any thread with a free event loop can serve:

| Who serves | Use when | Wiring |
| --- | --- | --- |
| The Wasmer client's thread | The FilesApi lives there (Node scripts, the engine worker) | `installHostFiles(mounts)` |
| The page's main thread | The FilesApi belongs to the UI (File System Access handles, an editor's state) | engine worker: `installHostFiles(forwardHostFiles(port))`; page: `serveHostFiles(port, mounts)` |
| A worker of its own | Storage with synchronous or slow back ends (OPFS, remote) kept off both | as above, with the worker serving |

### Security model

The FilesApi handed to `HostMounts.add()` is the boundary. Build it with
`@statewalker/webrun-files-composite`:

```js
const view = new CompositeFilesApi(new MemFilesApi())
  .mount("/input", readOnly(new FilteredFilesApi(input, newPathFilter("/.private"))))
  .mount("/output", new GuardedFilesApi(output, [{ operations: ["write"], check: (p) => p.endsWith(".txt") }]));
const id = mounts.add(view);
```

- Hidden paths (`FilteredFilesApi`) do not exist for the guest: `ENOENT`, and they are left out of
  listings.
- A refused mutation (a guard, `readOnly`) is `EACCES`, which Python raises as `PermissionError`. An
  error without a code from a mutating FilesApi call is treated as a refusal (fail closed); from a
  read it is `EIO`.
- The refusal comes at `open()` for writing, not at `close()`: the volume writes the file back once
  at its first open for writing, so guests that never close explicitly still see the error. Cost:
  one rewrite of the file per first open for writing.
- Paths are relative to the mount; `..` that escapes it is `EACCES`, absolute paths `EINVAL`.
- `HostMounts.add(files, { readOnly: true })` refuses every mutation before the FilesApi sees it.
- An unregistered mount id answers `ENOENT`.

Protocol details the volume handles: reads and writes in chunks of at most 64 KiB; files opened for
writing are buffered (FilesApi writes whole files) and written back on `flush`, `close` and `sync`;
times are reported from `lastModified` and `setTimes` is accepted but not stored; no symlinks.

## Isolation

- **Code:** each container is a WASIX sandbox in Wasmer's workers. A guest has no system calls
  outside WASIX and no access to the page's or the process's JavaScript.
- **Network:** `network: { mode: "http", peers: [] }`: a virtual localhost per container, no
  egress, and two containers cannot reach each other (tested). `enableInternet: true` is refused
  unless the engine was created with `egress: "host"`, which gives such a container the host's
  network, unfenced (for trusted build steps; Wasmer: Node only). Lifo guests reach the network
  through their worker's `fetch`: `lifoContainerEngine` guards it (and `WebSocket`,
  `XMLHttpRequest`, `EventSource`) unless a running container was started with
  `enableInternet` (tested in Node and Chromium).
- **Lifo is for trusted code.** Lifo is not a security boundary: guest JS runs in the worker's JavaScript realm and can reach its real globals (`Function('return globalThis')()`), so the egress guard and the mounts constrain cooperative code, not hostile code; in Node such code reaches `process` and from there the host's network and filesystem. Run untrusted code in Wasmer. The isolation above is Wasmer's.
- **Files:** only what the mounts' FilesApi allows (above).
- **Runaway guests:** a guest in a compute loop is not stopped by `kill()` or `destroy()`; only
  terminating its Wasmer client's worker stops it (`recyclableEngine`, above).
- **Failure domain:** a guest that crashes the runtime (`WORKER_FAILED`) stops the Wasmer client's
  whole worker pool, and every later start on that client fails ("Scheduler is dead"). Use one
  client per trust domain (per extension or tenant), and recreate the engine after `WORKER_FAILED`.
- **Not enforced:** CPU and memory limits per container (`instance_type`), disk size.

## cellb in practice

`ctx.container` is part of cellb's runtime (`@statewalker/cellb/container`):

- **The port.** `loadProject(…, { containers: engine })`, `ProjectHost.containers` or
  `createCellRuntime({ containers: { engine, images } })`. The engine can be in-process
  (`wasmerContainerEngine`) or in a worker (`connectEngine(port)`), which keeps Wasmer's core off
  the cells' thread.
- **The manifest.** `containers` keeps celld's keys; cellb's image comes from
  `cellb.containers.<class>` (`packages`, `files`, `entrypoint`, `env`), which celld and wrangler
  do not read. File references (`"./server.py"`) are read when the project is loaded from its
  sources, and `cellb build` writes their content into the built `wrangler.json`. A class without
  an image, or a host without an engine, is reported in `unsupported`, saying which is missing.
- **Lifecycle.** One container per cell, kept by the runtime across the object's instances
  (hibernation, resets), as celld keeps it across idle evictions. A container with no call for its
  inactivity timeout (10 minutes by default) is destroyed; `project.close()` destroys them all.
- **Not yet:** named host mounts in the manifest (a FilesApi is mounted from the host's code, see
  the pools), images stored as WEBC with a build (packages come from the registry and its cache),
  `max_instances`.

### On a fleet of cellb nodes

`cellb serve --containers MODULE` gives a fleet node an engine (the module's default export
makes it); this package has two such modules:

```sh
cellb serve ./project --bucket s3://cells/fleet --containers ./serve/lifo.ts     # Lifo, in a worker
cellb serve ./project --bucket s3://cells/fleet --containers ./serve/wasmer.ts   # Wasmer (WASIX)
```

A cell's container runs on the node that owns the cell. When the node dies or leaves, another
node takes the cell, starts the same image (`cellb.containers.<class>` of the project) and runs
the same scripts; the cell's storage goes on from where it was, the container's own files do not
(a new container, as on celld). Lifo runs in a worker of its own (`serve/lifo-worker.ts`): it
guards the network of the realm it runs in, which must not be the node's, whose bucket and peers
are reached with `fetch`. Behind an HTTP proxy, Wasmer reaches its registry from Node with
`NODE_USE_ENV_PROXY=1`.

`test/fleet-migration.test.ts` runs three `cellb serve` nodes on one RustFS bucket, six cells each
running a job script in its container on every call, then crashes (SIGKILL, the node's process
group) and stops (SIGTERM) the node owning the most cells. Every cell answers again on a live node,
its job runs in a new container there, and its run count goes on. Recorded in
`bench/results/fleet-migration.json` (Node 22, one 4-vCPU VM):

| | Lifo (`node job.js`) | Wasmer (`python job.py`) |
| --- | --- | --- |
| A cell's first call: container start / whole call | 26 ms / 171 ms | 2.8 s / 4.0 s |
| A call to a running container: the script / whole call (p50) | 64 ms / 70 ms | 249 ms / 262 ms |
| Its node crashes (SIGKILL): the cells answer again after | 9.0 s | 8.7 s |
| Its node leaves (SIGTERM): the cells answer again after | 0.19 s | 4.9 s (a new Python container starts) |

After a crash the cells wait for the dead node's lease (10 s from its last renewal), then the node
taking them recovers its log tier session first, as celld does. After a graceful leave they move
at once; what remains is the new container's start.

## Measured

| | Node 22 | Chromium |
| --- | --- | --- |
| First Python container, empty cache / cached | 3.4 s / 2.0 s | 5.3 s / 2.2 s |
| Next container, or restart | ~0.4 s | ~0.4 s |
| A request through `getTcpPort().fetch()` | 2–4 ms | 15–30 ms |
| Memory per Python container | 99 MB | 73 MB (renderer) |
| Python containers one node ran, all answering | **132** (stopped by the 2 GB reserve, 16 GB machine) | **123** (then the 124th start failed: the result records a timeout waiting for the guest's port; the console showed `WebAssembly.Memory()` failing) |

[Containers per node](docs/capacity.md) has the method, PHP, threads and the cost of closing a node.

## The @wasmer/sdk patch

`patches/@wasmer__sdk@0.19.1.patch` (pnpm `patchedDependencies`) adds what the SDK's core has but
its public API does not expose; each is a change to ask upstream for:

- `sandbox.ports.fetch(port, request)` and `sandbox.ports.connect(port)` (core `handleHttpRequest`,
  `connectTcp`): `getTcpPort()` without a ServiceWorker or real host ports;
- `mounts` (and `storage`) in `sandboxes.create()` (core `mountHost`, `storageHost`);
- the host-filesystem bridge in Node pool workers, as browser workers have it.

`scripts/patch-wasmer-sdk.mjs` regenerates it.

## Tests

```bash
pnpm --filter @statewalker/cellb-containers test
pnpm --filter @statewalker/cellb-containers e2e
```

`test` runs in Node (the Node example is skipped without JSPI, that is before Node 24). `e2e` runs
Chromium through Playwright; `PW_CHROMIUM` picks the binary. The first run downloads the WASIX
packages into `.wasmer/`.

Capacity runs are opt-in (Linux; minutes to an hour each):

```bash
CONTAINERS_CAPACITY=1 CAPACITY_EXAMPLES=python pnpm vitest run test/capacity.test.ts
CONTAINERS_CAPACITY=1 CAPACITY_MAX=200 CAPACITY_EXAMPLES=python pnpm e2e capacity
```

Not covered yet: Firefox and Safari; egress for Wasmer containers in browsers (none exists);
recovery after `WORKER_FAILED`. Not implemented: `storage` (a FilesApi as `/workspace`), which the
patched SDK supports.
