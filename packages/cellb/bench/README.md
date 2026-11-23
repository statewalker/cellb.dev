# Benchmarks

CellB's numbers for durability, speed and density, measured the way
[celld.dev](https://celld.dev) reports celld's. Each scenario runs in a child process of its own
and imports the built
package (`dist/`), as a user of the published package would. The browser half runs the same
Worker in a Dedicated Worker in Chromium.

```sh
pnpm bench                       # Node: build, then every scenario (about 2 minutes)
node --expose-gc bench/node-bench.mjs wake memory   # some scenarios
BENCH_JSON=bench/results/node.json pnpm bench        # also write the results
BENCH_JSON=bench/results/chromium.json pnpm bench:browser   # Chromium (BENCH_CELLS, default 1000)
```

`bench/results/` holds the last recorded run of each, and the numbers on cellb.dev are read from
those files.

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
  one's lease expires (10 s by default, `leaseTtlMs`); the measured failover is that wait plus the
  restore.
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
BENCH_JSON=bench/results/sockets-chromium.json pnpm probes:browser socket
```

A socket's frames used to be relayed over the isolate's multiplexed port. Now the socket's own
MessagePort is transferred to the host, so frames go straight to the isolate. The `*-relay.json`
files hold the runs from before that change; the "port" columns are the current runs
(`sockets-node.json`, `sockets-chromium.json`, with webrun-http-browser 0.12.2), on the same kind
of machine (4 vCPUs, Node 22, headless Chromium):

| Median of 3 runs | Node, relay | Node, port | Chromium, relay | Chromium, port |
|---|---|---|---|---|
| Echo round trip p50 / p99 (ms) | 0.14 / 0.98 | 0.09 / 0.52 | 0.2 / 1.6 | 0.1 / 0.3 |
| 64 B messages per second | 22,946 | 41,075 | 10,421 | 19,988 |
| 1 KiB messages per second | 17,793 | 32,665 | 8,734 | 15,917 |
| 64 KiB throughput (MB/s) | 65 | 227 | 68 | 132 |
| Sockets one isolate holds | 1,023 | 1,500 (all asked) | 1,023 | 1,500 (all asked) |

Before the change, each open socket held one of the isolate multiplexer's ports, and there could be
at most 1,024 of them at once (webrun-rpc's default), so the 1,024th socket was refused with an
HTTP 500 to the upgrade.

Each end of a socket counts every message's UTF-8 size, for `bufferedAmount` and for the byte
acknowledgements its peer sends. Until webrun-http-browser 0.12.2 that count was a loop over the
characters in JavaScript, about 0.26 ms per 64 KiB string, and it held 64 KiB echoes at about
75 MB/s on Node. It now runs natively (`TextEncoder.encodeInto`).

## Hybrid clusters

`cluster-bench.mjs` runs celld fleet nodes and `cellb serve` nodes on one bucket of a local RustFS
and loads them the same way: 32 concurrent clients increment 200 counters for 10 s, every request
to a random node, so with N nodes (N-1)/N of the requests cross to the cell's owner over celld's
peer tunnel. After each run it checks every counter (no value acknowledged twice, none lost).

```sh
pnpm bench:cluster                                         # build, then every scenario (~7 min)
DURABILITY=bucket scripts/interop-env.sh node bench/cluster-bench.mjs throughput  # cellb without leading
scripts/interop-env.sh node bench/cluster-bench.mjs throughput
CONFIGS="celld=2;cellb=2" DURATION_MS=5000 scripts/interop-env.sh node bench/cluster-bench.mjs throughput
BENCH_JSON=bench/results/cluster.json pnpm bench:cluster   # also write the results
```

Recorded in `results/cluster.json` (celld 0.6.3, Node 22, one 4-vCPU VM, every node and RustFS on
it):

| Nodes | Requests/s | p50 | p99 | CPU s / 1,000 requests |
|---|---|---|---|---|
| celld × 1 | 700 | 44 ms | 82 ms | 1.24 |
| celld × 2 | 1,555 | 17 ms | 91 ms | 1.25 |
| celld × 4 | 1,439 | 20 ms | 82 ms | 1.66 |
| cellb × 1 | 668 | 43 ms | 139 ms | 1.28 |
| cellb × 2 | 594 | 48 ms | 154 ms | 2.21 |
| cellb × 4 | 447 | 61 ms | 228 ms | 3.83 |
| celld × 1 + cellb × 1 | 662 | 57 ms | 146 ms | 0.79 + 1.28 |
| celld × 2 + cellb × 2 | 748 | 35 ms | 167 ms | 1.05 + 1.42 |

| 2 celld + 2 cellb, one node stops | Cells answering again | Longest gap | Failed requests | Lost or repeated values |
|---|---|---|---|---|
| a cellb node, `SIGKILL` | 40 / 40 | 9.8 s | 2,536 | 0 |
| a celld node, `SIGKILL` | 40 / 40 | 9.8 s | 1,435 | 0 |
| a cellb node, `SIGTERM` | 40 / 40 | 0.3 s | 0 | 0 |
| a celld node, `SIGTERM` | 40 / 40 | 0.6 s | 1 | 0 |

- **One node: the same.** A single node of either runtime answers about 680 requests/s, each
  write acknowledged after its LTX file is in the bucket (a lone node has no follower).
- **From two nodes, both lead log tier sessions.** celld and cellb nodes alike acknowledge a write
  once a follower holds it (`cellb serve` leads by default, `--durability fleet`), and each follows
  the others. For celld that is the jump from one node to two: its request path is fast, so the
  bucket's round trip was its latency. For cellb the latency is the same with `--durability bucket`
  (measured: p50 56 ms either way with two nodes): its request path in JavaScript, about 1.3 ms of
  CPU per request, is what bounds it on these 4 shared vCPUs, not the durability.
- **A routed call costs CellB about 0.9 ms of CPU** (30 s steady state with `DURABILITY=bucket`,
  1 vs 2 nodes: 1.13 and 1.60 CPU s / 1,000 requests, half of them routed); celld about 0.1 ms.
  Tunnels are reused, a node calls the owner it knows directly for as long as calls keep reaching
  it, and appends to a follower carry every row queued for it.
- **More nodes than CPUs.** Four nodes, RustFS and the load generator share 4 vCPUs, so neither
  runtime gains from the third and fourth node here.
- **A dead node's cells wait for its lease** (10 s), then for its log's recovery when it was a
  celld node. A node that leaves with `SIGTERM` releases its cells, and they move at once.

## cellb-only clusters, 4 to 10 nodes

`cluster-bench.mjs scale` runs N `cellb serve` nodes (no celld) on one bucket of a local RustFS,
loads them with closed-loop clients over 200 counters for 15 s, every request to a random node,
then checks every counter. Besides the cluster's requests/s and latency percentiles, it reports
for each node the latency of the requests that entered there, its CPU, its resident memory
(sampled every 500 ms; a node on Node 22 is two processes, `cellb serve` and the process it
relaunches itself as, counted together) and the cells it owns.

```sh
pnpm build
SCALE_NODES=4,6,8,10 DURATION_MS=15000 BENCH_JSON=bench/results/scale.json \
  scripts/interop-env.sh node bench/cluster-bench.mjs scale             # 128 clients (default)
SCALE_CLIENTS=16 BENCH_JSON=bench/results/scale-light.json …             # a light load
```

Heavy load, 128 clients (`results/scale.json`; Node 22, one 4-vCPU VM shared by every node, RustFS
and the clients):

| Nodes | Requests/s | p50 | p90 | p99 | p99.9 | CPU s / 1,000 req | Cores: nodes / RustFS | RSS per node (peak) | Cells per node | p99 per node | Errors / repeated / lost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 598 | 172 ms | 397 ms | 800 ms | 1,322 ms | 2.57 | 1.53 / 1.65 | 269–285 MB | 45–58 | 739 ms–849 ms | 0 / 0 / 0 |
| 6 | 588 | 178 ms | 400 ms | 779 ms | 1,064 ms | 3.13 | 1.84 / 1.52 | 232–261 MB | 21–40 | 638 ms–849 ms | 0 / 0 / 0 |
| 8 | 491 | 215 ms | 498 ms | 885 ms | 1,158 ms | 3.97 | 1.94 / 1.39 | 220–239 MB | 17–34 | 741 ms–994 ms | 0 / 0 / 0 |
| 10 | 405 | 260 ms | 596 ms | 1,017 ms | 1,301 ms | 4.86 | 1.95 / 1.27 | 209–233 MB | 15–26 | 938 ms–1,126 ms | 0 / 0 / 0 |

Light load, 16 clients (`results/scale-light.json`):

| Nodes | Requests/s | p50 | p90 | p99 | p99.9 | CPU s / 1,000 req | Cores: nodes / RustFS | RSS per node (peak) | Cells per node | p99 per node | Errors / repeated / lost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 384 | 38 ms | 63 ms | 106 ms | 146 ms | 4.42 | 1.7 / 1.22 | 234–253 MB | 39–56 | 102 ms–113 ms | 0 / 0 / 0 |
| 6 | 336 | 43 ms | 78 ms | 128 ms | 165 ms | 5.74 | 1.92 / 1.14 | 225–240 MB | 22–48 | 114 ms–144 ms | 0 / 0 / 0 |
| 8 | 299 | 45 ms | 93 ms | 175 ms | 256 ms | 6.76 | 2.02 / 1.02 | 199–228 MB | 20–31 | 149 ms–217 ms | 0 / 0 / 0 |
| 10 | 274 | 50 ms | 104 ms | 170 ms | 218 ms | 7.86 | 2.15 / 0.99 | 217–229 MB | 15–26 | 155 ms–198 ms | 0 / 0 / 0 |

- **The cluster is correct at every size**: no failed request, no value acknowledged twice, no
  counter behind its acknowledged values, and every one of the 200 cells owned by one node. Cells
  and requests spread evenly: each node's latency percentiles are within a few percent of the
  cluster's.
- **These numbers are of one machine, not of a fleet.** At 128 clients the 4 vCPUs are saturated
  (the nodes take 1.5–2 cores, RustFS 1.3–1.7, the clients 0.15), so latency is queueing: 128
  clients / ~600 requests/s ≈ 210 ms, Little's law. Each node added on the same CPUs adds its own
  event loop and routing (with N nodes, (N-1)/N of the requests cross to the owner), so
  throughput falls from 598 to 405 requests/s between 4 and 10 nodes. On machines of their own,
  nodes add capacity; here they share it.
- **A request costs 2.6–4.9 ms of CPU at heavy load, 4.4–7.9 ms at light load.** Under load,
  commits batch: one follower append and one bucket upload carry several requests' rows. An idle
  node costs about 1% of a core (lease renewals, log maintenance), and RustFS 0.15 cores for an
  idle 4-node cluster, so the difference is not a fixed overhead.
- **A node's memory stays at 200–290 MB** (both processes) from 4 to 10 nodes and at either load:
  it does not grow with the cells or the load measured here.
- **RustFS is the second largest consumer** (1–1.7 cores): every acknowledged write ends as an LTX
  file PUT, and every node renews its lease and polls its wake index.
