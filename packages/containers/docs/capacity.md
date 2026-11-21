# Containers per node

How many containers one cellb node runs and keeps using, in Node and in Chromium, and what limits
it. A node here is one cellb project with one container engine (one Wasmer client): a Node
process, or a browser worker.

## How it was measured

One cellb project (the [Python](../examples/python) or [PHP](../examples/php) example) and one
engine. Each step sends the first request to a new cell, which starts that cell's container (a
Python or PHP HTTP server). Then every earlier cell is asked again and must answer from its own
container, still running (`startedMs: 0`: not restarted). The run stops at `CAPACITY_MAX` (default
200 in Node, 64 in Chromium: set it to 200 to reproduce the Chromium numbers), at the
first failure, or before the machine has less than 2 GB left, as cellb's
[browser capacity](../../cellb/docs/browser-capacity.md) probes do. Memory is PSS from `/proc`
(shared pages divided among the processes sharing them): the Node process, or Chromium's renderer.

```sh
CONTAINERS_CAPACITY=1 CAPACITY_EXAMPLES=python BENCH_JSON=bench/results pnpm vitest run test/capacity.test.ts
CONTAINERS_CAPACITY=1 CAPACITY_MAX=200 CAPACITY_EXAMPLES=python BENCH_JSON=bench/results pnpm e2e capacity
node bench/summarize.mjs
```

Run one image per process: memory a Wasmer client gave back is not returned to the system within
the process, so a second image measured in the same process starts from the first one's peak.

The runs are in `bench/results/` (`node-capacity-*.json`, `chromium-capacity-*.json`). They were
measured on one 4-vCPU Linux VM with 16 GB of memory, Node 22.23 and headless Chromium 153,
`@wasmer/sdk` 0.19.1 (patched), on 2026-11-20, with the WASIX packages already in the cache.

## Results

| Runtime | Image | Containers | Stopped because | Memory per container | Start (median) | Asking all cells, last step | Closing the node |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Node 22 | Python 3.13 (`python/python`) | **132** | less than 2 GB left on the machine | 99 MB | 524 ms | 257 ms | 653 s |
| Node 22 | PHP 8.3 (`php/php-32`) | **68** | less than 2 GB left on the machine | 194 MB | 308 ms | 84 ms | 28 s |
| Chromium 153 | Python 3.13 | **123** | the 124th start failed (recorded: a timeout waiting for the guest's TCP port; the console: `WebAssembly.Memory(): could not allocate memory`), with 5.7 GB still free | 73 MB | 439 ms | 2,070 ms | |
| Chromium 153 | PHP 8.3 | **72** | less than 2 GB left on the machine (renderer at 12.9 GB) | 178 MB | 310 ms | 1,558 ms | |

Every container of a run kept answering until the run stopped: no cell lost its container and none
had to restart one.

## What limits it

- **Memory, and nothing before it.** Memory grows linearly with the containers, with no knee:
  about 100 MB per Python server and 195 MB per PHP server in Node (PHP's 32-bit build reserves
  more), 73 MB per Python server in Chromium's renderer. In Node the run ended only because the
  machine had 2 GB left. The first container also brings the engine: about 280 MB in Node (52 MB
  before it, 427 MB with one Python container), about 350 MB in the renderer.
- **In Chromium, WebAssembly memories, not only memory.** Each guest has a WebAssembly memory of
  its own. Starting the 124th Python guest failed: the result
  (`bench/results/chromium-capacity-python.json`) records a timeout waiting for the guest's TCP
  listener, and the console showed `RangeError: WebAssembly.Memory(): could not allocate memory`, at
  9.1 GB of renderer memory, with 5.7 GB still free on the machine, while the
  PHP run went on to 12.9 GB and 72 guests without that error. So the limit is not the renderer's
  memory alone; a limit on how many WebAssembly memories a renderer creates, or on the address space
  they reserve, is the likely cause (not confirmed). The failure stopped the Wasmer client's whole
  worker pool (`WORKER_FAILED`): the containers already running stopped answering. One client is
  one failure domain.
- **Threads.** One thread per container, on top of the engine's own (12 in Node, about 25 in the
  renderer): 144 threads at 132 Python containers in Node, 151 in the renderer at 123. Chromium's
  limit of about 125 Dedicated Workers per tab ([browser capacity](../../cellb/docs/browser-capacity.md))
  was not reached first: Wasmer's pool workers are nested in the node's worker.
- **Asking every cell.** In Node a request to a running container costs 2 ms; in Chromium about
  15 ms, so going through all 120 cells took 2 seconds there.
- **Closing a node takes long with many containers.** Closing the engine destroys its
  containers, and the Wasmer client then shuts its workers down: 28 s for 68 PHP containers, 653 s
  for 132 Python containers (198 s to destroy them, 443 s for the client to close). A node that
  runs that many should be stopped without waiting for it (end the process or the worker).

## In practice

- **A browser tab:** plan for a few containers, not dozens. Python costs 73 MB each and the tab
  shares its memory with the page and every cell; the hard stops came far above what a tab should
  use (123 Python guests, 12.9 GB with PHP).
- **A Node process:** about 100 MB per Python container and 200 MB per PHP container, plus about
  280 MB for the engine. A 16 GB machine held 132 Python servers.
- **Running custom code:** a [pool](../README.md#running-custom-code-the-pool) keeps `size`
  sandboxes warm and destroys each after its run, so its memory is `size` times the image's cost,
  whatever the number of runs.
