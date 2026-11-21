# Isolated pools: one worker per container

A pool of workers prepared ahead of time, each holding one container of a given kind (Python, PHP,
Node-compatible JavaScript, ...). A request takes a ready container, runs its command, and the
container goes with its worker; a fresh one takes its place. When none is ready, the request waits.

**The strategy works, in Node and in Chromium, for Wasmer and for Lifo.** Terminating a worker
gives its memory back at once in Node and within 100 ms in Chromium, stops everything in it (a
guest stuck in a compute loop included), and nothing builds up over many cycles. The price is
memory and warm-up time per container, which depend on the runtime.

## Measurements

4-vCPU Linux VM, 16 GB, Node 22.23, headless Chromium 153, `@wasmer/sdk` 0.19.1 (patched),
`@lifo-sh/core` 0.10.36, 2026-11-20. Scripts: `bench/worker-pool-node.ts`,
`bench/lifo-workers-node.ts`, `e2e-browser/worker-pool.spec.ts` (`WORKER_POOL_PROBE=1`),
`e2e-browser/isolated.spec.ts`.

| | Wasmer, Python (Node) | Wasmer, Python (Chromium) | Lifo, Node-compatible JS (Node) | Lifo (Chromium) |
| --- | --- | --- | --- | --- |
| Memory per ready container | ~275 MB | ~265 MB (renderer) | ~31 MB | not measured |
| First containers, cold (in parallel) | 4.1 s | 6.0 s | 0.2 s for 4 | 0.56 s for 2 |
| A replacement (refill) | 0.83 s median (0.76–0.99, 30 refills) | 0.8 s; every third ~2.1 s | not measured (4 cold in 0.2 s) | not measured |
| A run (exec in a warm container) | ~250 ms | ~280 ms | ~85 ms with acquire and terminate | not measured |
| Terminating the worker | 15–25 ms; memory and threads back at once | memory back within 100 ms | memory back within 500 ms | not measured |
| Memory over 30 single-use cycles (Node) / 20 (Chromium) | steady (612 → 639 MB) | steady (~820 MB) | not measured | not measured |
| Left in the process after all workers ended | ~340–380 MB, once | ~160 MB, once | not measured | not measured |

For comparison, a pool sharing one Wasmer client ([`createContainerPool`](../README.md#running-custom-code-the-pool))
costs about 100 MB per Python sandbox and starts one in about 0.4 s, but a crashing guest takes the
whole client down, and a compute loop needs a recyclable engine to be stopped.

| | Shared engine (`createContainerPool`) | One worker per container (`createIsolatedPool`) |
| --- | --- | --- |
| Memory per Python container | ~100 MB | ~275 MB |
| Replacement | ~0.4 s | ~0.8 s |
| A crashing guest | stops every container of the client | stops its own worker only |
| A compute loop past its timeout | stopped only with `recyclableEngine` | stopped with its worker |
| Memory after use | given back when the client closes | given back when the worker ends |
| Runtimes | Wasmer | any engine in a worker: Wasmer, Lifo, ... |

## API

The pool is close to what celld and Cloudflare offer: what a request holds is a container with
`ctx.container`'s API, and `run()` is a one-call form like the Sandbox SDK's `exec`.

```ts
import { createIsolatedPool } from "@statewalker/cellb-containers";

const pool = createIsolatedPool({
  spawn: () => new Worker(new URL("./python-worker.ts", import.meta.url), { type: "module" }),
  image: { packages: ["python/python"] }, // or a server: files + entrypoint
  size: 4, // containers kept ready
  warmup: ["python", "-c", "pass"], // compiled while warming, so a run starts hot
});

// one call: a fresh container, the run's files at /data, then the worker is terminated
const r = await pool.run({ argv: ["python", "-c", code], files, env, timeoutMs: 10_000 });

// or hold it: ctx.container's API, until destroy()
const c = await pool.acquire({ files, timeoutMs: 30_000 });
await c.waitForPort(8080);
const res = await c.getTcpPort(8080).fetch("http://container/");
await c.destroy(); // terminates its worker; the pool already started a replacement
```

The worker (one file per kind of container):

```ts
// python-worker.ts
import { Wasmer } from "@wasmer/sdk/browser"; // or /node
import { serveContainerWorker, wasmerWorkerEngine } from "@statewalker/cellb-containers";
serveContainerWorker(self, ({ files }) => wasmerWorkerEngine(new Wasmer(), files));

// node-worker.ts
import * as lifo from "@lifo-sh/core";
import { serveContainerWorker } from "@statewalker/cellb-containers";
import { lifoContainerEngine } from "@statewalker/cellb-containers/lifo";
serveContainerWorker(self, ({ files }) => lifoContainerEngine(lifo, { files }));
```

In Node, `spawn` returns a `worker_threads` Worker and the worker passes `parentPort` instead of
`self`.

Lifo reaches the network through its realm's `fetch` (its `npm`, `curl`, a guest's `fetch` and
`node:http` clients). `lifoContainerEngine` guards that realm: containers have no network, and an
engine created with `egress: "host"` gives it to a container started with `enableInternet: true`
(a build step). The guard covers the whole worker, which is why a Lifo engine needs a worker of
its own. Lifo's own runtime files (esbuild-wasm from unpkg, in browsers) stay reachable. Lifo's
`npm` exits 0 when a package cannot be fetched (it warns on stderr): check what it installed.

The guard keeps cooperative code off the network; it is not a sandbox. Lifo is not a security boundary: guest JS runs in the worker's JavaScript realm and can reach its real globals (`Function('return globalThis')()`), so the egress guard and the mounts constrain cooperative code, not hostile code; in Node such code reaches `process` and from there the host's network and filesystem. Run untrusted code in Wasmer. The
worker-per-container pool still gives Lifo runs a fresh realm each, and frees them at once.

WebSockets cross the worker both ways. Into the box: `getTcpPort(port).fetch()` of an upgrade
request answers 101 with the socket's `MessagePort` (`containerWebSocket(container, port)` is a
`WebSocket` class over it). Out of it: `lifoContainerEngine(lifo, { webSocket })` installs a WHATWG
WebSocket class as the realm's `WebSocket`, which a guest's `WebSocket` and `node:http` upgrades
use; with `createWebSocketClass` from `@statewalker/webrun-http-browser`, the box's sockets reach
handlers the host chooses, with no network. Lifo runs one command at a time: start a server as the
image's entrypoint (a background job, in `workdir`), not with `exec()`.

| Cloudflare / celld | Isolated pool |
| --- | --- |
| `ctx.container` of a Durable Object | the `Container` from `pool.acquire()` |
| `container.start()` | done while warming; `start()` resolves at once |
| `getTcpPort(p).fetch()`, `.connect()` | the same (`connect()`: Wasmer only) |
| `exec`, `signal`, `monitor`, `destroy` | the same; `destroy()` terminates the worker |
| `getRandom(binding, n)` (load balancing over containers) | `pool.acquire()`: any ready one |
| Sandbox SDK `sandbox.exec(cmd)` | `pool.run({ argv, files, env, timeoutMs })` |
| `max_instances` | `size` (ready) + requests in progress |

### How it works

- `WarmPool<T>` keeps `size` instances ready: a request takes one or waits in line (with a timeout
  or an abort signal); a replacement starts as soon as one is taken; failed creates back off
  (250 ms, doubling, up to 30 s); after `failAfter` failures in a row (default 5) the waiting
  requests fail with the cause, and the pool keeps retrying for later ones; `maxCreating` caps
  creates at once. It has no dependencies and
  knows nothing about workers.
- Each instance of an isolated pool is a worker running `serveContainerWorker`, an engine served
  over the existing engine RPC (`connectEngine`), and a started container. A run's FilesApi is
  bound to the container's mount for that run only; the pool serves it on its own thread.
- Files reach a runtime the way it can take them: Wasmer's guests call the host-filesystem bridge
  (asynchronous on the host side); Lifo's mounts are synchronous, so `syncHostFiles()` posts the
  same requests and blocks on `Atomics.wait` until the pool's thread answers (it needs
  SharedArrayBuffer: cross-origin isolation in browsers).

## Start times: one run per container

An isolated pool with `slots: 1` (the default): each container in a worker of its own, warmed
ahead of time, handed to one script, and terminated with its worker when the script exits. Pool
size 2; times from the request to the result, acquire and termination included.
`bench/isolated-start-node.ts`, `e2e-browser/isolated-start.spec.ts` (`WORKER_POOL_PROBE=1`).

| | QuickJS (`wasmer/quickjs`) | Python (`python/python`) | edgejs (`wasmer/edgejs`, JSPI) |
| --- | --- | --- | --- |
| Node 22/24: 2 containers cold, in parallel | 1.0 s | 2.1 s | 3.1 s |
| Node: memory per ready container | 106 MB | 306 MB | 354 MB |
| Node: a run with a container ready | **21 ms** | 185 ms | 388 ms |
| Node: refill (a new worker, warmed) | 234 ms | 573 ms | 743 ms |
| Node: a run when none is ready | 451 ms | 2.2 s | 1.75 s |
| Node: 8 runs at once on 2 ready | 1.3 s | 3.6 s | 4.7 s |
| Chromium 153: 2 containers cold | 2.4 s | 5.2 s | 5.8 s |
| Chromium: a run with a container ready | **34 ms** | 196 ms | 326 ms |
| Chromium: refill | 376 ms | 550 ms | 2.2 s |

Medians of 10 runs (8 in Chromium); edgejs ran on Node 24. "When none is ready" emptied the pool
first, so two refills competed for the CPU. A run's cost is mostly the runtime's own start (a
process in a warm, compiled engine): QuickJS answers in tens of milliseconds, edgejs pays for
Node's bootstrap. Keep `size` at the expected burst: a request that finds the pool empty waits
for a whole refill.

## Several scripts per container

A container (one worker, one engine) can run more than one script at a time. Whether scripts of
different callers may share it depends on what isolates them inside the engine, so we verified
that first (`test/multi-script.test.ts`, Node 22, `wasmer/quickjs`):

- **One sandbox per script, in one Wasmer client: isolated.** Six scripts ran at once, each in a
  sandbox of its own with its own FilesApi mounted at `/data`. Each saw only its own `/data`,
  `/tmp`, `/workspace` and environment, and the host's FilesApis got only their own script's files.
- **Several processes in one sandbox: not isolated.** They share the sandbox's mounts and
  `/workspace`; only `/tmp` and the root are per process. Only scripts with the same capabilities
  (the same FilesApi view) may share a sandbox.
- **Lifo: one command at a time per box**, and boxes in one worker share `console` and `process`.
  N = 1: one worker per script.

What an extra script costs in a warm Wasmer client (`bench/multi-script-node.ts`; each script does
200 ms of CPU; 4 vCPUs):

| Runtime | Starting a sandbox | Memory per running sandbox | 8 scripts at once | 16 at once |
| --- | --- | --- | --- | --- |
| QuickJS (`wasmer/quickjs`) | ~1 ms | 17–28 MB | 1.8× the time of one | 6.6× |
| Node-compatible JS (`wasmer/edgejs`, Node 24) | ~1 ms | 65–78 MB | 2.6× | 6.7× |
| Python (`python/python`) | ~1 ms | 46–65 MB | 10.9× | 63× |
| Lifo (one worker each) | (a worker: ~50 ms) | ~31 MB | one at a time per box | |

QuickJS and edgejs keep scaling to about two scripts per core; Python degrades within one client
(four at once already took 4.4× the time of one), so Python scales better across workers than
within one.

The pool takes this as two options:

```ts
// Many callers' scripts on few workers: a fresh sandbox per script (verified isolated for Wasmer).
createIsolatedPool({ spawn, image: { packages: ["wasmer/quickjs"] }, size: 1, slots: 8, isolation: "sandbox" });

// Scripts that may share a sandbox: a worker is bound to one capabilities key (one FilesApi view).
const pool = createIsolatedPool({ spawn, image, size: 1, slots: 4, isolation: "shared" });
await pool.run({ argv, files: aliceFiles, capabilities: "alice" }); // alice's runs share a sandbox
await pool.run({ argv, files: bobFiles, capabilities: "bob" });     // never alice's
```

- `slots: 1` (the default) is one container per run, terminated after it.
- With slots, a worker serves runs until `maxRunsPerContainer` (200) or `idleMs` (30 s) without
  one. A timed-out script retires its worker: the other scripts on it get `drainMs` (30 s) to
  finish, then the worker is terminated, which is what stops a compute loop. A script that must
  never be slowed by a neighbour's runaway loop needs `slots: 1`.
- Suggested settings: QuickJS or edgejs, `slots` about twice the cores the pool may use; Python,
  `slots: 1` or `2` and more workers; Lifo, `slots: 1`.

Tests: `test/script-slots.test.ts` (8 scripts on 2 workers of 4 slots, each with only its own
files; no trace of a script for the next on the same worker; a timeout retiring a worker after its
sibling finishes; capability-bound sharing, and refusal of runs with no key or other files).

## Runtimes

| Runtime | What runs | Where | Fit | Status |
| --- | --- | --- | --- | --- |
| [Wasmer](https://docs.wasmer.io/runtime/js/) (`@wasmer/sdk`) | WASIX builds: Python, PHP, bash, Node-compatible JS (`wasmer/edgejs`, JSPI) | browsers, Node | full: exec, spawn, fetch, connect, mounts | implemented |
| [Lifo](https://lifo.sh/) (`@lifo-sh/core` 0.10.36, MIT) | a Linux-like OS in TypeScript: shell, 60+ commands, Node-compatible JS (`node`, `npm`), Python through Pyodide | browsers, Node ≥ 20 | exec, fetch, mounts (synchronous); no raw sockets, no streaming stdin; commands on one box run one at a time; anything its realm logs to `console` during a command lands in that command's output, so its worker must run nothing else | implemented |
| [almostnode](https://almostnode.dev/) (0.2.14, MIT) | Node-compatible JS with an npm installer, Vite and Next dev servers | browsers only | poor: self-described experimental and not production-ready, no release since 2026-02; shell, stdin and server state are module-level singletons (one container per realm, so one iframe per container); no destroy, no per-command env, no pluggable filesystem | evaluated, not implemented |

An almostnode engine would run in an iframe per container (a page of ours calling its
`createContainer()`), answer the engine RPC over `postMessage`, and copy files in and out of its
`VirtualFS`, since it cannot mount a host filesystem. Nothing in the pool would change.

### Adding a runtime

Implement `ContainerEngine` (`start(spec)` returning a handle with `exec`, `fetch`, `waitForPort`,
`destroy`, and `spawn` and `connect` if the runtime has them), and serve it from a worker with
`serveContainerWorker`. For files, use `forwardHostFiles(files)` if the runtime calls Wasmer's
bridge, or `syncHostFiles(files, mountId)` behind its own synchronous filesystem hooks. The pool
contract (`test/isolated-contract.test.ts`) then runs the same tests on it.

## Pool libraries

We looked for a library to manage the pool (versions from npm on 2026-11-20) and wrote
`WarmPool` instead:

- **Task pools** (piscina, tinypool, workerpool, poolifier, threads.js) dispatch function calls
  to long-lived, reused workers. Here a request needs one specific prepared instance, used once and
  terminated. tinypool's `isolateWorkers` comes closest but is Node-only.
- **Resource pools** fit the model. generic-pool 3.9.0 (last release 2022) has destroy-and-
  replace, but its `min` counts busy instances (it cannot keep N idle), a failing create retries
  with no backoff, and it needs a Node `events` shim in browsers. tarn cannot destroy a single
  instance. lightning-pool has the right semantics (`minIdle`) but is Node-only.
- `WarmPool` is about 150 lines with no dependencies, the same in Vite and Node, and replaces an
  instance when it is taken rather than when it is returned.
