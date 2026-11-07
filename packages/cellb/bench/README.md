# Benchmarks

CellB's numbers for durability, speed and density, measured the way
[celld.dev](https://celld.dev) reports celld's. Each scenario runs in a child process of its own and imports the built
package (`dist/`), as a user of the published package would. The browser half runs the same
Worker in a Dedicated Worker in Chromium.

```sh
pnpm bench                       # Node: build, then every scenario (about 2 minutes)
node --expose-gc bench/node-bench.mjs wake memory   # some scenarios
BENCH_JSON=bench/results/node.json pnpm bench        # also write the results
BENCH_JSON=bench/results/chromium.json pnpm bench:browser   # Chromium (BENCH_CELLS, default 1000)
```

`results/` holds the last recorded run of each, and the website (`site/` at the repository root)
reads them.

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

- **One machine, trivial cells.** The recorded runs come from one 4-vCPU Linux VM, which
  `results/*.json` describes. They show CellB's own costs, not those of a fleet.
- **The bucket is simulated.** `durable` adds a fixed delay per store operation, while a real S3
  bucket adds its own tail latency. Point the scenario at `s3ObjectStore` to measure one.
- **HTTP goes through a `node:http` bridge.** CellB's runtime is a `(Request) ⇒ Response` handler,
  so the HTTP row includes converting Node's request and response to Fetch objects.
- **Failover time is mostly the node lease.** A second node may take a cell only after the first
  one's lease expires (10 s by default, `leaseTtlMs`); the measured failover is that wait plus the restore.
- **Browser timers are coarse.** A Dedicated Worker's `performance.now()` has about 0.1 ms
  resolution, so sub-millisecond browser rows round to 0 or 0.1.

## WebSockets into a loaded Worker

`socket-bench.mjs` (Node) and `e2e-browser/probes/socket.probe.spec.ts` (Chromium) measure a
WebSocket into a Worker loaded at run time (Worker Loader), which runs in an isolate of its own.
The Worker is the partyserver extension of `test/partyserver`, run as a facet. Each benchmark runs
3 times (`RUNS`) and reports the median of:

- an echo round trip (2,000 of them, after 200 to warm up);
- throughput at 64 B, 1 KiB and 64 KiB, with messages sent back to back until the last echo;
- how many sockets one isolate holds at once (up to 1,500).

```sh
pnpm build && BENCH_JSON=bench/results/sockets-node.json node bench/socket-bench.mjs
BENCH_JSON=bench/results/sockets-chromium.json pnpm bench:browser socket
```

A socket's frames used to be relayed over the isolate's multiplexed port. Now the socket's own
MessagePort is transferred to the host, so frames go straight to the isolate. The `*-relay.json`
files hold the runs from before that change, on the same machine (4 vCPUs, Node 22, headless
Chromium):

| Median of 3 runs | Node, relay | Node, port | Chromium, relay | Chromium, port |
|---|---|---|---|---|
| Echo round trip p50 / p99 (ms) | 0.14 / 0.98 | 0.10 / 0.65 | 0.2 / 1.6 | 0.1 / 0.5 |
| 64 B messages per second | 22,946 | 32,515 | 10,421 | 18,918 |
| 1 KiB messages per second | 17,793 | 29,364 | 8,734 | 16,021 |
| 64 KiB throughput (MB/s) | 65 | 192 | 68 | 114 |
| Sockets one isolate holds | 1,023 | 1,500 (all asked) | 1,023 | 1,500 (all asked) |

Before the change, each open socket held one of the isolate multiplexer's ports, and there could be
at most 1,024 of them at once (webrun-rpc's default), so the 1,024th socket was refused with an
HTTP 500 to the upgrade.
