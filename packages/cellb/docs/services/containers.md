# Containers

A container runs a program that is not JavaScript beside the Durable Object that needs it: a
Python or PHP server, a shell, Node-compatible JavaScript. celld runs containers with Docker or
Podman. CellB runs them in browsers and in Node with
[`@statewalker/cellb-containers`](../../../containers/README.md), which backs Cloudflare's
`ctx.container` API with two engines: [Wasmer](https://docs.wasmer.io/runtime/js/) WASIX sandboxes
(Python, PHP, bash, your own WASI builds; the isolation boundary, for code you do not trust) and
[Lifo](https://lifo.sh), a Linux-like OS in TypeScript (shell, `node`, `npm`; for code you trust).
No daemon, no image registry at run time, the same object code.

Try both in a tab: [Python in Wasmer containers](https://cellb.dev/demos/containers/python/) and
[an Observable Framework notebook in Lifo containers](https://containers.cellb.dev/notebook/).
[Two engines: Wasmer and Lifo](../../../containers/README.md#two-engines-wasmer-and-lifo) compares them.

Containers are experimental in CellB. An object of a `containers` class gets `ctx.container` when
the host gives the runtime a container engine and the class has an image for CellB in the
`cellb.containers` key of its wrangler config; otherwise the class is reported in `unsupported`,
saying which of the two is missing.

Only software compiled to WASI/WASIX runs: Python, PHP, bash, Node-compatible JavaScript
(`wasmer/edgejs`), your own Rust or C. An arbitrary Linux image does not; that class stays on
celld, with its Dockerfile.

## Example

The [Python example](../../../containers/examples/python) starts a stdlib HTTP server per object
and reaches it through a container port. Its `wrangler.jsonc` keeps celld's `containers` entry and
adds the image CellB runs; the same `server.py` runs in Docker on celld and in a Wasmer sandbox on
CellB:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "PY", "class_name": "PyRunner" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PyRunner"] }],
  "containers": [{ "class_name": "PyRunner", "image": "./Dockerfile" }], // what celld builds
  "cellb": {
    "containers": {
      "PyRunner": {
        "packages": ["python/python"],
        "files": { "server.py": "./server.py" }, // a file of the project, or the content itself
        "entrypoint": ["python", "/workspace/server.py"]
      }
    }
  }
}
```

The object's code is the same on celld and on CellB:

```js
import { DurableObject } from "cloudflare:workers";

export class PyRunner extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      await container.start({ env: { CELL: this.ctx.id.name } });
      await container.waitForPort?.(8080); // CellB; on celld the Container class polls
    }
    return container.getTcpPort(8080).fetch(request);
  }
}
```

The host gives the runtime an engine, once per node:

```js
import { loadProject } from "@statewalker/cellb/node"; // or /browser, in a worker
import { wasmerContainerEngine } from "@statewalker/cellb-containers";
import { Wasmer } from "@wasmer/sdk/node"; // or /browser

const engine = wasmerContainerEngine(new Wasmer());
const project = await loadProject("./my-project", { containers: engine });
// ...
await project.close(); // destroys the project's containers
```

`createCellRuntime({ containers: { engine, images } })` and `createProjectRuntime(config, module,
{ containers })` take the same engine. File references in `files` (values starting with `./` or
`../`) are read when the project is loaded from its sources, and `cellb build` writes their content
into the built `wrangler.json`.

More examples: [pool](../../../containers/examples/pool) (custom code run on a pool, against each
cell's own files), [PHP](../../../containers/examples/php) (PHP's built-in server),
[Node](../../../containers/examples/node) (a `node:http` server in `wasmer/edgejs`, which needs
WebAssembly JSPI: Node 24+ or Chromium 137+), and [files](../../../containers/examples/files) (a host
FilesApi mounted into a container).

## The object and its container

Each cell of a container class has at most one container. The runtime keeps it per cell, not per
object instance, so an object woken from hibernation or reset gets the same running container, as
on celld. CellB's `ctx.container` (`@statewalker/cellb/container`) implements:

- `start()` with `entrypoint` and `env`. `enableInternet: true` is refused unless the engine
  allows egress (`egress: "host"`, for trusted build steps; not for a node's cells).
- `running`, and `monitor()`, which settles when the container exits.
- `destroy()`, and `signal()` (15 terminates with a grace period, 9 kills).
- `getTcpPort(port).fetch()` sends an HTTP request to a port; `getTcpPort(port).connect()` opens a
  raw socket (a readable and a writable stream).
- `exec()` runs a process to completion; `spawn()` runs one with streamed stdin, stdout and stderr.
- `waitForPort(port)`, not in Cloudflare's API (its `Container` class polls with `fetch`).
- `setInactivityTimeout()`: a container with no activity for that long (10 minutes by default, as
  on Cloudflare) is destroyed; the next `start()` starts a fresh one. Every call is activity, and
  so is a call still running (an `exec()`, a request through a port until its response, an open
  `connect()` socket); a WebSocket after its 101 is not, so keep a long-lived one alive with calls.
- A `destroy()` during a `start()` destroys what that start brings up, and a closing runtime
  starts no container: `project.close()` destroys every container of the project after its grace
  period.

An image in `cellb.containers` is a set of WASIX packages from the Wasmer registry
(`python/python`, `php/php-32`, `wasmer/bash`, `wasmer/edgejs`), text files written under
`/workspace` (inline, or `./` references to files of the project, which must stay inside it), an
entrypoint (none for an exec-only container), a `workdir` and environment variables. Package bytes
and host mounts are for code that calls `createContainer` or the pools directly.

## Running custom code

For code an object receives (an agent's tool call, a user's script) rather than a server it keeps,
a pool fits better than a container per object. `createContainerPool(engine, mounts, { image, size
})` keeps `size` fresh sandboxes started; each `run({ argv, files, env, timeoutMs })` takes one,
with the run's own FilesApi at `/data`, and the sandbox is destroyed afterwards, so nothing of a
run reaches the next. The host provides it by name and objects call `containerPool(name).run(…)`:

```js
export class Workspace extends DurableObject {
  files = new MemFilesApi(); // this cell's files
  async fetch(request) {
    const result = await containerPool("python").run({
      argv: ["python", "-c", await request.text()],
      files: this.files,
      timeoutMs: 10_000,
    });
    return Response.json(result); // { exitCode, stdout, stderr, timedOut, ms }
  }
}
```

For the strongest isolation, `createIsolatedPool` keeps each container in a worker of its own and
terminates it after use: its memory is given back at once and nothing of it survives, at about 2.7
times the memory of a shared engine for Python. It runs Wasmer or [Lifo](https://lifo.sh) (shell
and Node-compatible JS) behind the same API ([Isolated pools](../../../containers/docs/isolated-pools.md)).

A timeout stops a guest that makes system calls. A guest in a pure compute loop ignores `kill()`
and keeps its Wasmer worker busy after its sandbox is gone; give a pool that runs untrusted code a
`recyclableEngine`, which replaces the engine's worker on a timeout and terminates the old one.

## The engine and the node

The engine is one per node: one Wasmer client for a Node process or for a browser node, shared by
every cell the node owns. Wasmer's core (package download and compile, the virtual filesystem,
the scheduler) runs on the thread that creates the client and stalls it for up to 1.5 seconds on a
first start, so put the engine in a worker: `serveEngine(port, engine)` there, and
`connectEngine(port)` where the cells run, which returns an engine with the same interface. In a
browser, the node's Dedicated Worker is a worker already; Wasmer's own pool workers then start as
nested workers. A browser node needs cross-origin isolation (COOP/COEP), as CellB's LTX store does.

A container runs on the node that owns the cell. `project.close()` destroys the project's
containers, and closing the engine (`engine.close()`, a tab close, a process exit) destroys all of
its containers, as a celld node stop does.

How many containers one node runs is in [Containers per node](../../../containers/docs/capacity.md).

## Files

A container sees the host's files only through mounts: `mounts: [{ path: "/data", id }]`, where
`id` is a FilesApi registered with `HostMounts`. That FilesApi is the security boundary: build it
with `@statewalker/webrun-files-composite` (mounted sub-trees, hidden paths, guards, read-only
views). Hidden paths do not exist for the guest; refused writes fail with `EACCES` at `open()`.
The FilesApi can live on the engine's thread, on the page's main thread or in a worker of its own:
the package README has the details.

## Isolation

- A guest runs in a WASIX sandbox in Wasmer's workers, with no system calls outside WASIX and no
  access to the page's or the process's JavaScript.
- No network out, and a localhost of its own: two containers cannot reach each other.
- Files only through the mounts' FilesApi.
- Not enforced: CPU and memory limits (`instance_type`), disk size.
- A guest in a compute loop is not stopped by `kill()`: only terminating its Wasmer client's worker
  stops it (`recyclableEngine`).
- A guest that crashes the Wasmer runtime stops the client's whole worker pool, and every later
  start on that client fails: one client is one failure domain.

## Differences from celld

- Only WASIX software runs, not Docker images. The image comes from `cellb.containers.<class>`,
  not from `image`.
- No egress for cells (`enableInternet: true` is refused); an engine with `egress: "host"` is
  for trusted build steps, unfenced.
- No `instance_type` limits or `max_instances` yet.
- Wasmer packages published as zstd-compressed WEBC (`sharrattj/coreutils`, `wasmer/winterjs`,
  `sqlite/sqlite`) do not load with `@wasmer/sdk` 0.19.1.
- `@cloudflare/containers` (the `Container` class) reads `ctx.container`; it is not tested on
  CellB yet.
- `@cloudflare/sandbox` does not run: its control server is part of the `cloudflare/sandbox` Docker
  image.
