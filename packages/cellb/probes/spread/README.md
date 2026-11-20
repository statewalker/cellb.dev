# Spread probes: one project over many workers, frames and threads

These probes check whether a CellB host can spread a project's Durable Objects over more
workers than one page (or one process) allows, and keep their data on a FilesApi the host
opens. They were written for `statewalker/statewalker-root#177`. They are exploratory: they print
measurements and are not part of `pnpm e2e` or `pnpm test`.

- **The project:** `project/` has one Durable Object class. A *task* is one call to an object:
  some CPU work, then a row of random kilobytes in the object's SQLite. Each row records the
  worker that ran it, so a probe can check that every object stays in one worker.
- **Browser:** the probe is `e2e-browser/probes/spread.probe.spec.ts`. Its pages are
  `e2e-browser/pages/spread/` and `e2e-browser/pages/labs/spread-backup.html`.
  - Workers are started with `startProjectShards`.
  - A *frame node* is an iframe of another origin that starts its own shards and serves
    the project's HTTP to the host over a MessagePort (`serveHandlerOverPort` / `linkOverPort`).
- **Node:** `node.ts` runs the project over worker threads, wired as `startProjectShards` wires
  browser workers (a port between every two threads, `route` by `shardOf`). `node-shard.ts` is
  one thread. `run-node.mjs` bundles both with esbuild and runs them.

```sh
pnpm probes:browser spread -g "tasks"              # SPREAD_WORKERS=1,2,4,8
pnpm probes:browser spread -g "how many workers"   # SPREAD_STEPS=16,32,64,96,128,160
pnpm probes:browser spread -g "stored volume"      # SPREAD_VOLUME_MB=4096 (a profile on disk)
pnpm probes:browser spread -g "frames"             # SPREAD_FRAMES=4 SPREAD_FRAME_WORKERS=40
pnpm probes:browser spread -g "host's FilesApi"    # SPREAD_BACKUP_MB=512
pnpm probes:spread-node                            # tasks threads volume backup (or a subset)
```

`SPREAD_JSON=<dir>` writes each result as JSON. Every probe stops before the machine has less
than `SPREAD_RESERVE_MB` (2048) left. The memory figures come from `/proc`, so the probes run on
Linux only.

## Results (2026-11-20)

The runs were on one Linux VM with 4 vCPUs (Intel Xeon, 2.30 GHz) and 16 GB of memory, in
headless Chromium 1243 and Node 22.23. The raw results are in `bench/results/spread/`.

### Tasks shared by workers

The project has 64 objects. The CPU-bound load runs 8 rounds at about 10 ms of work per task.
The write-bound load runs 4 rounds of 256 KB per task.

| Workers / threads | Browser CPU-bound (tasks/s) | Browser write-bound (MB/s) | Node CPU-bound (tasks/s) | Node write-bound (MB/s) |
|---|---|---|---|---|
| 1 | 91 | 6.2 | 180 | 67 |
| 2 | 112 | 8.0 | 249 | 80 |
| 4 | 178 | 12.8 | 386 | 123 |
| 8 | 194 | 11.9 | 409 | 136 |

- Every object stayed in one worker in every run (`movedObjects: 0`).
- Throughput grows up to the 4 cores and then flattens.
- The browser's write-bound figures are for 256 KB rows through the OPFS pool. The stored-volume
  run below writes 1 MiB rows at about 190 MB/s.

### How many workers or threads start

**Browser, one page.**
- 96 shard workers started (3.9 GB of Chromium PSS).
- At 128 workers a shard failed with `RangeError: WebAssembly.Memory(): could not allocate memory`
  while 10.5 GB of the machine's memory was still free.
- This is the limit of one renderer process: every worker's SQLite WASM memory is reserved
  inside that process's address space. CellB's earlier probe stopped at 125 workers
  (`docs/browser-capacity.md`).

**Browser, frames of other origins.** Each frame runs 40 workers.

| Frames | Workers | Same-site frames (`f<i>.spread.test`) | Cross-site frames (`f<i>.node<i>.test`) |
|---|---|---|---|
| 1 | 40 | ok, 4 renderers | ok, 5 renderers |
| 2 | 80 | ok, 4 renderers | ok, 6 renderers |
| 3 | 120 | ok, 4 renderers | ok, 7 renderers |
| 4 | 160 | **fails**: `WebAssembly.Memory(): could not allocate memory` | **ok**, 8 renderers; largest renderer 1.3 GB |

- **Same-site frames share the host's renderer process and its limit.** Cross-site frames each
  get a process of their own, so 160 workers start where one page stops below 128.
- So the frames must be on another *site* (another registrable domain, or a zone on the Public
  Suffix List), not just another origin. Subdomains of the host's domain do not help.
- A directory handle the host posts to a frame of another origin does not arrive. The frame
  gets a `messageerror`, so frames cannot write to the host's folder directly. The host has to
  serve its FilesApi to them over a port.

**Node.**
- 256 worker threads ran in one process (8.0 GB RSS, about 31 MB per thread).
- An earlier run reached 384 threads (11.2 GB RSS).
- At 512 threads the container's memory limit killed the process.
- In Node the limit is memory only. There is no per-process address-space ceiling like the
  browser's.

### Stored volume

- **Browser.** A profile on disk (`launchPersistentContext`) with 4 workers wrote 6 GiB, 1 MiB
  per task, at about 190 MB/s, without reaching its quota. `navigator.storage.estimate()`
  reported a quota of 19.7 GB and usage of 8.9 GB. The usage figure moves in steps and runs
  ahead of the data.
  **Open question:** the renderer's PSS grew with the volume written, to 8.3 GB after 6 GiB.
  Why, and whether it is released, was not measured. Until it is known, it may limit how much
  one page can write.
- **Node.** 4 threads wrote 6 GiB (6.0 GB on disk) at about 250 MB/s. RSS stayed at 570 MB.

### Cells on the host's FilesApi, then re-sharded

In this probe, 4 workers or threads write 512 MiB of cells whose data lives in the host's
FilesApi. Then 8 workers or threads, with nothing of their own, open the same cells from it.

| | Browser (LTX VFS, `files: { module, args: { dir } }`) | Node (`filesApiLtxLog` over `rpcFilesClient`) |
|---|---|---|
| What the host serves | a `FileSystemDirectoryHandle` (OPFS here; `showDirectoryPicker` gives the same type) | a `NodeFilesApi` folder, served from the main thread over a port |
| Write throughput | 6.1 MB/s | 28.9 MB/s |
| Host folder after writing | 543 MB in 385 files | 517 MB |
| Reopened by 8 workers | all 2,048 rows, 512 MiB, in 26 s | all 2,048 rows, 512 MiB, in 54 s |

- In both, the data survives a change of placement (4 → 8) because the host's FilesApi holds it.
  This is the property that lets the host move cells between workers, frames or processes.
- Throughput there is far below writing to the worker's own storage (about 190 MB/s browser,
  250 MB/s Node). Every commit is an LTX file written through the FilesApi.
- In a browser, `bucket: { ltx }` needs cross-origin isolation. That is why the page is under
  `/labs/` and its shard worker is `labs/spread-shard-worker.ts`: the store worker a shard starts
  must be isolated too.
