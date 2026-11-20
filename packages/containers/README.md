# @statewalker/cellb-containers

Containers for cellb in browsers and in Node: Cloudflare's `ctx.container` API, as celld runs it
with Docker, backed here by [Wasmer](https://docs.wasmer.io/runtime/js/) WASIX sandboxes. A
Durable Object of a `containers` class gets a container that runs Python, PHP, bash or
Node-compatible JavaScript next to it, in a tab or in a Node process, with no Docker daemon.

Status: experimental. It runs on `@wasmer/sdk` 0.19.1 (alpha) with a small patch, and cellb itself
is unchanged: projects reach their container through `containerFor(ctx, image)` until
`ctx.container` is built into cellb (see [Integration into cellb](#integration-into-cellb)).

It is an engine beside celld's Docker, not a replacement: only software compiled to WASI/WASIX
runs. The same class runs on celld with its Dockerfile; each example ships both.

## What is in the package

| Module | What it does |
| --- | --- |
| `engine` | The `ContainerEngine` port and `wasmerContainerEngine(wasmer)`: containers with or without a main process, no egress, a localhost of their own, host mounts, `exec`, `spawn` with streamed stdio, `close()` destroying every container |
| `container` | `createContainer(engine, image)`: `ctx.container` as Cloudflare and celld define it (`start`, `running`, `monitor`, `destroy`, `signal`, `exec`, `getTcpPort(p).fetch()` / `.connect()`), plus `waitForPort`, `spawn`. `provideContainerEngine()` / `containerFor()` connect a project's objects to the node's engine |
| `rpc` | `serveEngine(port, engine)` / `connectEngine(port)`: the engine in a worker, the cells holding a proxy with the same interface |
| `files` | `FilesVolume`: Wasmer's host-filesystem protocol served by any `FilesApi`. `HostMounts` (`add`, `reserve`, `bind`, `remove`), `installHostFiles`, `forwardHostFiles`, `serveHostFiles`: route a guest's filesystem calls to the thread that owns the FilesApi |
| `pool` | `createContainerPool(engine, mounts, { image, size })`: runs custom code, each run in a fresh sandbox with its own FilesApi, env and timeout. `provideContainerPool()` / `containerPool()` reach it from Durable Objects |
| `recycle` | `recyclableEngine(spawn)`: an engine whose instance (a Wasmer client in a worker of its own) is replaced when a guest will not stop |

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

Each is a cellb project with the Dockerfile celld would build from the same source.

| Example | Container | Runs on |
| --- | --- | --- |
| [`examples/python`](examples/python) | A stdlib HTTP server per cell (`python/python`) | Node 22+, Chromium |
| [`examples/php`](examples/php) | PHP's built-in server (`php/php-32`) | Node 22+, Chromium |
| [`examples/node`](examples/node) | A `node:http` server in `wasmer/edgejs`, Node-compatible JavaScript in WASIX | Node 24+, Chromium 137+ (WebAssembly JSPI) |
| [`examples/files`](examples/files) | A host script: a composite FilesApi (read-only, filtered `/input`, writable `/output`) mounted for a Python analysis | Node 22+ |
| [`examples/pool`](examples/pool) | A Durable Object per workspace runs code it is sent on the host's pool, against its own FilesApi | Node 22+, Chromium |

In a project:

```js
import { DurableObject } from "cloudflare:workers";
import { containerFor } from "@statewalker/cellb-containers/container";

export class PyRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // celld gives ctx.container; on cellb the node's engine provides it
    this.container = ctx.container ?? containerFor(ctx, IMAGE);
  }
}
```

and in the host, once per node:

```js
const withdraw = provideContainerEngine(wasmerContainerEngine(new Wasmer()));
const project = await loadProject(dir);
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
  until an egress policy exists (a fenced WISP relay in browsers, an egress hook in Node).
- **Files:** only what the mounts' FilesApi allows (above).
- **Runaway guests:** a guest in a compute loop is not stopped by `kill()` or `destroy()`; only
  terminating its Wasmer client's worker stops it (`recyclableEngine`, above).
- **Failure domain:** a guest that crashes the runtime (`WORKER_FAILED`) stops the Wasmer client's
  whole worker pool, and every later start on that client fails ("Scheduler is dead"). Use one
  client per trust domain (per extension or tenant), and recreate the engine after `WORKER_FAILED`.
- **Not enforced:** CPU and memory limits per container (`instance_type`), disk size.

## Integration into cellb

Today the package runs beside cellb: cellb reports a `containers` entry as unsupported, and objects
call `containerFor(ctx, image)`. Built into cellb, it becomes:

1. **A port.** `ProjectHost.containers?: ContainerEngine` next to `openSql` and `storage`. Node
   hosts pass `connectEngine(port)` to an engine in a `worker_threads` worker; browser hosts pass an
   engine in the node worker or `connectEngine` to a worker of its own.
2. **The manifest.** A `containers` entry keeps celld's keys; the cellb image comes from the `cellb`
   key, so the same file deploys to celld unchanged:

   ```jsonc
   "containers": [{ "class_name": "PyRunner", "image": "./Dockerfile", "instance_type": "basic" }],
   "cellb": { "containers": { "PyRunner": {
     "packages": ["python/python@=3.13.15"],
     "files": { "server.py": "./server.py" },
     "entrypoint": ["python", "/workspace/server.py"],
     "mounts": [{ "path": "/data", "files": "workspace", "readOnly": false }]
   } } }
   ```

   A class with an image is no longer reported as unsupported; one without stays reported, naming
   the key.
3. **`ctx.container`.** `DurableObjectState` gets `container = createContainer(engine, image, {
   label })` for objects of a container class, so project code is the same as on celld.
4. **Lifecycle, as celld.** The container runs where the cell's lease is. An idle eviction keeps it
   for the inactivity window (`setInactivityTimeout`, 10 minutes by default) and the next
   activation on the same node reconnects; a lease handover, a tab close or a node stop destroys it.
   `max_instances` counts per node.
5. **Mounts.** Named host FilesApis (`"files": "workspace"`) resolve to `HostMounts` ids that the
   host registered, with the policy built by the host, never by the project.
6. **Images.** `cellb build` resolves packages to WEBC bytes and stores them with the build (and in
   the fleet bucket, as celld stores image tarballs), so nodes never contact the registry.

## Measured

| | Node 22 | Chromium |
| --- | --- | --- |
| First Python container, empty cache / cached | 3.4 s / 2.0 s | 5.3 s / 2.2 s |
| Next container, or restart | ~0.4 s | ~0.4 s |
| A request through `getTcpPort().fetch()` | 2–4 ms | 15–30 ms |
| Memory per Python container | 99 MB | 73 MB (renderer) |
| Python containers one node ran, all answering | **132** (stopped by the 2 GB reserve, 16 GB machine) | **123** (then the renderer could not allocate WebAssembly memory) |

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
CONTAINERS_CAPACITY=1 CAPACITY_EXAMPLES=python pnpm e2e capacity
```

Not covered yet: Firefox and Safari, `enableInternet`, `storage` (a FilesApi as `/workspace`),
recovery after `WORKER_FAILED`.
