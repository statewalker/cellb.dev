# Benchmarks

CellB's numbers, measured the way [celld.dev](https://celld.dev) reports celld's: durability,
speed and density. Each scenario runs in a child process of its own and imports the built
package (`dist/`), as a user of the published package would. The browser half runs the same
Worker in a Dedicated Worker in Chromium.

```sh
pnpm bench                       # Node: build, then every scenario (about 2 minutes)
node --expose-gc bench/node-bench.mjs wake memory   # some scenarios
BENCH_JSON=bench/results/node.json pnpm bench        # also write the results
BENCH_JSON=bench/results/chromium.json pnpm bench:browser   # Chromium (BENCH_CELLS=1000)
```

`results/` holds the last recorded run of each; the website (`site/`) reads them.

## What each scenario measures

| Scenario | How | celld.dev row |
|---|---|---|
| `stateless` | A Worker that answers `ok`: 50,000 sequential `runtime.fetch` calls in the process, then over loopback HTTP (`node:http`) from a second process, sequential and with 64 connections | Stateless request p50 / p99, throughput |
| `wake` | 1,000 cells with a row each, hibernated with `hibernateIdle(0)`, then one read each: with the database left open, and closed (`closeDatabaseAfterMs`). Then 200 inactive cells restored from an in-memory bucket by a new runtime | Wake a hibernated cell |
| `memory` | RSS and V8 heap grown by 5,000 resident cells (a table and a row each), after GC | RAM per resident cell, resident cells per 8 GB (at 80 % of it) |
| `durable` | Sequential writes to one cell on `celldBucket`, whose store waits 0, 20 or 90 ms per operation (a stand-in for the bucket's round trip); with and without `pageCapture` | Durable write latency |
| `failover` | A child node streams acknowledged writes to one cell on a shared bucket (`sqliteObjectStore`, 10 s node lease) and is `SIGKILL`ed after 300; its local database is deleted; a second node with no local state reads the cell until it gets it | Writers per cell, acknowledged writes lost on kill, failover |
| Chromium | Stateless `runtime.fetch`, 2,000 commits to one cell on OPFS (opfs-sahpool), 1,000 resident cells hibernated and woken, SQLite WASM memory per cell | the same rows, in a tab |

## Reading the numbers

- **One machine, trivial cells.** The recorded runs come from one 4-vCPU Linux VM
  (`results/*.json` names it). They show CellB's own costs, not a fleet's.
- **The bucket is simulated.** `durable` adds a fixed delay per store operation; a real S3
  bucket adds its own tail latency. Point the scenario at `s3ObjectStore` to measure one.
- **HTTP is Node's `node:http` bridge.** CellB's runtime is a `(Request) ⇒ Response` handler;
  the HTTP row includes converting Node's request and response to Fetch objects.
- **Failover is the node lease.** A second node may take a cell only after the first one's lease
  expires (10 s by default, `leaseTtlMs`); the measured failover is that wait plus the restore.
- **Browser timers are coarse.** A Dedicated Worker's `performance.now()` has about 0.1 ms
  resolution, so sub-millisecond browser rows round to 0 or 0.1.
