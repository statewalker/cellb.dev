# Containers

A container runs a program that is not JavaScript beside the Durable Object that needs it: a
Python or PHP server, a shell, Node-compatible JavaScript. celld runs containers with Docker or
Podman. CellB runs them in browsers and in Node with
[`@statewalker/cellb-containers`](../../../containers/README.md), which backs Cloudflare's
`ctx.container` API with [Wasmer](https://docs.wasmer.io/runtime/js/) WASIX sandboxes: no daemon,
no image registry at run time, the same object code.

Containers are experimental in CellB. CellB's runtime itself still reports a `containers` entry in
`unsupported`; until `ctx.container` is built in, an object reaches its container through
`containerFor(ctx, image)` from the package, on the engine the host provides.

Only software compiled to WASI/WASIX runs: Python, PHP, bash, Node-compatible JavaScript
(`wasmer/edgejs`), your own Rust or C. An arbitrary Linux image does not; that class stays on
celld, with its Dockerfile.

## Example

The [Python example](../../../containers/examples/python) starts a stdlib HTTP server per object
and reaches it through a container port. Its `wrangler.jsonc` keeps celld's `containers` entry, and
the same `server.py` runs in Docker on celld and in a Wasmer sandbox on CellB:

```js
import { DurableObject } from "cloudflare:workers";
import { containerFor } from "@statewalker/cellb-containers/container";
import SERVER from "./server.py"; // a Text module rule

const IMAGE = {
  packages: ["python/python"],
  files: { "server.py": SERVER },
  entrypoint: ["python", "/workspace/server.py"],
};

export class PyRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // celld gives ctx.container; on CellB the node's engine provides it
    this.container = ctx.container ?? containerFor(ctx, IMAGE);
  }

  async fetch(request) {
    if (!this.container.running) {
      await this.container.start({ env: { CELL: this.ctx.id.name } });
      await this.container.waitForPort?.(8080);
    }
    return this.container.getTcpPort(8080).fetch(request);
  }
}
```

The host provides the engine once per node, before it loads the project:

```js
import { loadProject } from "@statewalker/cellb/node"; // or /browser, in a worker
import { provideContainerEngine, wasmerContainerEngine } from "@statewalker/cellb-containers";
import { Wasmer } from "@wasmer/sdk/node"; // or /browser

const withdraw = provideContainerEngine(wasmerContainerEngine(new Wasmer()));
const project = await loadProject("./my-project");
// ...
await withdraw(); // destroys the node's containers
```

More examples: [pool](../../../containers/examples/pool) (custom code run on a pool, against each
cell's own files), [PHP](../../../containers/examples/php) (PHP's built-in server),
[Node](../../../containers/examples/node) (a `node:http` server in `wasmer/edgejs`, which needs
WebAssembly JSPI: Node 24+ or Chromium 137+), and [files](../../../containers/examples/files) (a host
FilesApi mounted into a container).

## The object and its container

Each object of a container class controls at most one container. CellB's `ctx.container` (from
`createContainer` / `containerFor`) implements:

- `start()` with `entrypoint` and `env`. `enableInternet: true` is refused: containers have no
  egress yet.
- `running`, and `monitor()`, which settles when the container exits.
- `destroy()`, and `signal()` (15 terminates with a grace period, 9 kills).
- `getTcpPort(port).fetch()` sends an HTTP request to a port; `getTcpPort(port).connect()` opens a
  raw socket (a readable and a writable stream).
- `exec()` runs a process to completion; `spawn()` runs one with streamed stdin, stdout and stderr.
- `waitForPort(port)`, not in Cloudflare's API (its `Container` class polls with `fetch`).
- `setInactivityTimeout()` is accepted and not yet acted on.

An image is a set of WASIX packages from the Wasmer registry (`python/python`, `php/php-32`,
`wasmer/bash`, `wasmer/edgejs`) or package bytes, files written under `/workspace`, an entrypoint
(none for an exec-only container), environment variables and host mounts.

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

A container runs on the node that owns the cell. Destroying the engine (`withdraw()`, a tab close,
a process exit) destroys its containers, as a celld node stop does.

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

- Only WASIX software runs, not Docker images. The image comes from the package's own description
  (in code today; the `cellb` key of the manifest once built into CellB), not from `image`.
- No egress (`enableInternet: true` is refused).
- No `instance_type` limits, `max_instances` or inactivity window yet.
- Wasmer packages published as zstd-compressed WEBC (`sharrattj/coreutils`, `wasmer/winterjs`,
  `sqlite/sqlite`) do not load with `@wasmer/sdk` 0.19.1.
- `@cloudflare/containers` (the `Container` class) reads `ctx.container`, which CellB does not set
  yet: use `containerFor()` until it does.
- `@cloudflare/sandbox` does not run: its control server is part of the `cloudflare/sandbox` Docker
  image.
