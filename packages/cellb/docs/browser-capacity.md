# How many cells a browser holds

This page records what limits the number of cells one browser tab can run, measured in Chromium,
and what each limit costs in memory. It covers one worker, many workers, and what changed when
cellb stopped using SQLite WASM's defaults for cell connections. Words such as *cell* and *shard*
are defined in [CONTEXT.md](../CONTEXT.md); how a browser runs cells is in
[browser-host.md](browser-host.md).

## How it was measured

Two probes in `e2e-browser/probes`, run against the capacity page (`e2e-browser/pages/capacity`):

- `capacity.probe.spec.ts`: one worker makes cells resident in steps (each cell opens its
  database on the worker's OPFS pool, creates a table and writes a row) until a step fails. After
  each step it reads the memory of every Chromium process from `/proc` (PSS: shared pages divided
  among the processes that share them). Then it hibernates every cell with its database closed,
  and wakes 500 of them. `CAPACITY_ROLLING=1` closes every database after each step instead.
- `workers.probe.spec.ts`: how many workers one tab starts (each loads SQLite WASM, makes a
  runtime and one cell), and how many cells several workers hold together, each grown until it
  fails. Both stop before the machine has less than 2 GB left.

```sh
pnpm probes:browser capacity                                   # one worker
CAPACITY_ROLLING=1 pnpm probes:browser capacity                # databases closed after each step
WORKERS_MAX=128 pnpm probes:browser workers -g "how many workers"
CAPACITY_WORKERS=4 pnpm probes:browser workers -g "cells across"
```

`BENCH_JSON=<file>` writes a run's result; the runs on this page are in `bench/results/`
(`chromium-capacity*.json`, `chromium-workers.json`, `chromium-cells-across-4-workers.json`).
They were measured on one 4-vCPU Linux VM with 16 GB of memory, in headless Chromium, on
2026-11-02. Cells are trivial: one table and one short row. Linux only, as the probes read `/proc`.

## What one cell costs

| | SQLite WASM defaults | cellb's connections (lookaside off, 4 KiB pages) |
|---|---|---|
| SQLite WASM heap | 240 KB | 101 KB |
| Renderer process (PSS) | 206 KB | 155 KB |
| All of Chromium (PSS) | 273 KB | 239 KB |
| OPFS (the origin's usage) | 29 KB | 26 KB |
| Resident cells in one worker | **8,000** (then `SQLITE_NOMEM`) | **20,000** (then `SQLITE_NOMEM`) |

- **SQLite's heap is the hard limit of one worker.** SQLite WASM's memory is at most 2 GiB
  (32,768 pages, set in `sqlite3.wasm`). A step past it fails with `SQLITE_NOMEM`.
- **SQLite's defaults spend about 258 KB on a connection with one small table.** The WASM build
  uses 8 KiB pages and lookaside, and the page cache starts with a block of pages, so the page
  size sets most of a connection's memory. `PRAGMA cache_size` does not lower it (measured in Node
  with the same build, 1,000 connections):

  | Connection settings | Heap per connection |
  |---|---|
  | defaults (8 KiB pages, lookaside) | 258 KB |
  | lookaside off | 213 KB |
  | `cache_size=16` or `cache_size=2` | 258 KB |
  | 4 KiB pages | 176 KB |
  | 4 KiB pages, lookaside off (cellb now) | 120 KB |
  | 1 KiB pages, lookaside off | 27 KB |

  `tuneCellConnection` (`src/adapters/wasm-sqlite.ts`) turns lookaside off and gives a new
  database 4 KiB pages, celld's page size (SQLite's native default; celld sets none). A database
  that already holds data keeps its page size. 1 KiB pages would fit far more cells, but make
  every larger database cost more reads.
- **Half of a cell's memory is now outside SQLite.** With the new connections, SQLite's heap is
  101 KB of the 239 KB a cell costs Chromium: about 54 KB more in the renderer (the cell's object,
  storage and runtime state in JavaScript) and about 84 KB in Chromium's other processes. Where
  those 84 KB go is not measured per process; not open files (the renderer had 34 file
  descriptors at 3,000 cells), but likely OPFS held in memory by the probe's off-the-record
  context ([below](#the-probes-run-in-an-off-the-record-context)).
- **Creating a cell is slow:** about 12–17 ms each in one worker (a database file and its journal
  in OPFS, the pool growing as it fills). Waking a hibernated cell whose database was closed takes
  about 10–12 ms.

## Memory is reused, never returned

A WebAssembly memory grows and never shrinks, so SQLite's heap stays at its high-water mark until
its worker ends. Memory a closed database freed is reused by the next one opened:

- In Node, 1,000 connections closed and 1,000 new ones opened grew the heap by 0 MB.
- In Chromium (with SQLite WASM's defaults), with every database closed after each step of 1,000
  cells, the heap stayed at 259.5 MB from 1,000 to 3,000 cells.
- After one worker ran out of memory, closing every database and waking 500 cells worked.

So the 2 GiB limits how many cells are **open** at once, not how many a worker keeps on disk.
`closeDatabaseAfterMs` closes the databases of idle, hibernated cells. To give the memory back to
the browser, end the worker: its cells are in OPFS, and the next worker opens them.

## How many workers one tab runs

| Workers | Start of one (ms) | All of Chromium (PSS) | Renderer (PSS) |
|---|---|---|---|
| 1 | 1,129 | 446 MB | 116 MB |
| 64 | 352 | 3,107 MB | 2,725 MB |
| 125 | 602 | 5,338 MB | 4,921 MB |

- **125 workers**, each with SQLite WASM, a runtime and one cell. The 126th failed with
  `RangeError: WebAssembly.Memory(): could not allocate memory`, with 9.9 GB of the machine's
  memory still free. This looks like an address-space limit, not a memory one: on 64-bit, V8
  reserves address space for each WebAssembly memory (its maximum plus guard regions), and the
  renderer runs out of room for more reservations. The workers of one tab share its renderer
  process.
- **Each idle worker costs about 40 MB**, nearly all of it in the renderer.
- Workers are threads: past the number of cores, more workers add room for cells, not speed.

## How many cells several workers hold

Four workers, grown together by 1,000 cells each per step:

| Cells | Per worker | SQLite heaps (sum) | All of Chromium (PSS) | Machine memory left |
|---|---|---|---|---|
| 8,000 | 2,000 | 865 MB | 2,126 MB | 13.2 GB |
| 20,000 | 5,000 | 2,153 MB | 5,242 MB | 10.0 GB |
| 32,000 | 8,000 | 3,306 MB | 6,867 MB | 8.5 GB |

- **32,000 cells**, then every worker failed in the same step with `SQLITE_IOERR` (OPFS:
  `Unknown write() failure`), each worker's heap at about 830 MB, far from its 2 GiB, and
  6 GB of the machine's memory still free. A second run stopped at the same count. The limit is
  shared by the four workers, not one worker's heap. It is not open files: at 3,000 cells the
  page's renderer had 34 file descriptors open. The likely limit is the origin's storage quota in
  the probe's browser context (next section): 3,072 MB there, against 10,240 MB in a profile on
  disk on the same machine. Not yet confirmed by a run in a profile on disk.
- Up to 32,000 cells, each cost about 208 KB of Chromium's memory (from 359 MB with no cells).
  The failed step itself took Chromium to 9.3 GB.

## The probes run in an off-the-record context

Playwright gives each test a new browser context, which Chromium keeps off the record, like an
incognito window: its storage, OPFS included, is likely held in memory, under a quota of 3,072 MB
on this machine (10,240 MB for a profile on disk). Two numbers on this page probably depend on it:

- the shared limit of 32,000 cells in four workers (a quota, not memory);
- the memory outside SQLite's heap and the renderer, about 84 KB a cell in Chromium's other
  processes: OPFS files held in memory would be there.

SQLite's heap per cell, the 2 GiB limit of one worker and the number of workers do not depend on
where OPFS keeps its files.

## What follows for an application

- **Open cells:** about 20,000 small cells per worker with cellb's connections (8,000 with SQLite
  WASM's defaults); more for cells with smaller pages, fewer for cells that read more pages.
- **Cells on disk:** not limited by memory. Close idle databases (`closeDatabaseAfterMs`), and a
  worker keeps as many cells as OPFS holds, at about 26 KB each for a small cell.
- **Workers:** up to about 125 in one tab here, about 40 MB each when idle. Several workers raise
  the open-cell limit until the shared limit above, about 32,000 cells in four workers.
- **The machine:** about 210–240 KB per open cell for all of Chromium in these runs, likely less
  in a profile on disk, where OPFS is not held in memory.
- **The storage quota:** the origin's quota bounds the cells on disk, and in an off-the-record
  window it is a few GB of memory.

## What was not measured

- Firefox and Safari.
- Cells on LTX files (`bucket: { ltx }`) or IndexedDB (`bucket: { idb }`): the probes use OPFS
  pools. LTX cells read pages through a page cache instead.
- Cells with more data: every number here is for a table with one row.
- Where the memory outside SQLite's heap goes, per process.
- A profile on disk: whether the 32,000-cell limit of four workers moves with the quota, and how
  much memory a cell then costs outside the renderer.
