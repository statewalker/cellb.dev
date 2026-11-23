#!/usr/bin/env node
// Hybrid clusters: celld fleet nodes and `cellb serve` nodes on ONE S3 bucket (a local RustFS),
// measured side by side (statewalker/cellb.dev#208).
//
//   pnpm build && scripts/interop-env.sh node bench/cluster-bench.mjs              # every scenario
//   scripts/interop-env.sh node bench/cluster-bench.mjs throughput                  # some of them
//   BENCH_JSON=bench/results/cluster.json scripts/interop-env.sh node bench/cluster-bench.mjs
//
// Scenarios:
//   throughput  N nodes (celld only, cellb only, both) behind no balancer: every client request
//               goes to a random node, so (N-1)/N of them cross to the cell's owner over celld's
//               peer tunnel. Closed loop, CLIENTS concurrent clients, NAMES counters, DURATION_MS.
//               Reports requests/s, latency percentiles, CPU seconds per 1,000 requests per runtime,
//               which cells each runtime owns, and checks every counter (no value twice, none lost).
//   failover    2 celld + 2 cellb under load; one node of a kind is SIGKILLed. Reports how long its
//               cells were unavailable (the node lease, 10 s, plus recovery) and acknowledged
//               writes lost (must be 0).
//   leave       the same, with SIGTERM: a graceful leave. Reports failed requests and the gap.
//   scale       cellb-only clusters of SCALE_NODES nodes (default 4,6,8,10) under heavy load
//               (SCALE_CLIENTS, default 128, concurrent clients over NAMES counters): requests/s,
//               latency percentiles (p50, p90, p99, p99.9, max) for the cluster and for the requests
//               entering each node, each node's CPU, resident memory (sampled every 500 ms: average
//               and peak), and cells owned, then the counters checked (no value twice, none lost).
//
// Every node runs on this one machine, so the numbers show how the runtimes compare and what
// routing costs, not how a fleet of machines scales: N nodes share the same CPUs.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CELLD = process.env.CELLD_BIN;
const ENDPOINT = process.env.RUSTFS_ENDPOINT;
if (!CELLD || !ENDPOINT)
  throw new Error("run under scripts/interop-env.sh (CELLD_BIN, RUSTFS_ENDPOINT)");
const BUCKET = process.env.BENCH_BUCKET ?? "cells";
const CLIENTS = Number(process.env.CLIENTS ?? 32);
const NAMES = Number(process.env.NAMES ?? 200);
const DURATION_MS = Number(process.env.DURATION_MS ?? 10_000);
const CLK_TCK = 100; // /proc/<pid>/stat ticks per second on Linux
const { s3ObjectStore } = await import(new URL("../dist/index.js", import.meta.url).href);
const env = {
  ...process.env,
  PATH: `${process.env.ESBUILD_DIR}:${process.env.PATH}`,
  AWS_ACCESS_KEY_ID: "rustfsadmin",
  AWS_SECRET_ACCESS_KEY: "rustfssecret",
  AWS_REGION: "us-east-1",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
/** CPU seconds of a process and its descendants (`cellb serve` relaunches itself on Node 22). */
const cpuSeconds = (pid) => {
  let total = 0;
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    total += (Number(f[11]) + Number(f[12])) / CLK_TCK; // utime + stime
    for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/))
      if (child) total += cpuSeconds(Number(child));
  } catch {}
  return total;
};
/** Resident memory (MB) of a process and its descendants. */
const rssMB = (pid) => {
  let total = 0;
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    total += m ? Number(m[1]) / 1024 : 0;
    for (const child of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/))
      if (child) total += rssMB(Number(child));
  } catch {}
  return total;
};
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

async function cluster(counts) {
  const prefix = `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const bucketUrl = `s3://${BUCKET}/${prefix}`;
  const dir = join(mkdtempSync(join(os.tmpdir(), "cluster-bench-")), "counter");
  cpSync(join(HERE, "../conformance/celld-examples/counter"), dir, { recursive: true });
  execFileSync(CELLD, ["deploy", ".", "--bucket", bucketUrl, "--endpoint", ENDPOINT], {
    cwd: dir,
    env,
    stdio: "pipe",
  });
  const nodes = [];
  const start = async (kind, i) => {
    const at = await freePort();
    const name = kind === "cellb" ? `cellb-${prefix}-${i}` : `celld-${i}`;
    const args =
      kind === "celld"
        ? [
            CELLD,
            [
              "--bucket",
              bucketUrl,
              "--endpoint",
              ENDPOINT,
              "--listen",
              `127.0.0.1:${at}`,
              "--internal-listen",
              `127.0.0.1:${await freePort()}`,
            ],
          ]
        : [
            process.execPath,
            [
              "--no-warnings",
              join(HERE, "../bin/cellb.mjs"),
              "serve",
              dir,
              "--bucket",
              bucketUrl,
              "--endpoint",
              ENDPOINT,
              "--listen",
              `127.0.0.1:${at}`,
              "--node",
              name,
              ...(process.env.DURABILITY ? ["--durability", process.env.DURABILITY] : []),
            ],
          ];
    const p = spawn(args[0], args[1], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout.on("data", (d) => (log += d));
    p.stderr.on("data", (d) => (log += d));
    const ready = kind === "celld" ? /readiness is open/ : / ready http/;
    for (let t = 0; t < 300 && !ready.test(log) && p.exitCode === null; t++) await sleep(100);
    if (!ready.test(log)) throw new Error(`${name} did not start:\n${log.slice(-1500)}`);
    nodes.push({ kind, name, p, base: `http://127.0.0.1:${at}` });
  };
  for (let i = 0; i < (counts.celld ?? 0); i++) await start("celld", i);
  for (let i = 0; i < (counts.cellb ?? 0); i++) await start("cellb", i);
  const store = s3ObjectStore({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    prefix,
    region: "us-east-1",
    accessKeyId: "rustfsadmin",
    secretAccessKey: "rustfssecret",
  });
  return {
    nodes,
    async ownersByNode() {
      const by = {};
      for (const k of (await store.list("cells/")).filter((k) => k.endsWith("/own.json"))) {
        const node =
          JSON.parse(new TextDecoder().decode((await store.get(k)).body)).node || "released";
        by[node] = (by[node] ?? 0) + 1;
      }
      return by;
    },
    async owners() {
      const by = {};
      for (const k of (await store.list("cells/")).filter((k) => k.endsWith("/own.json"))) {
        const node = JSON.parse(new TextDecoder().decode((await store.get(k)).body)).node;
        const kind = !node ? "released" : node.startsWith("cellb-") ? "cellb" : "celld";
        by[kind] = (by[kind] ?? 0) + 1;
      }
      return by;
    },
    async close() {
      await Promise.all(
        nodes.map(
          (n) =>
            new Promise((r) => {
              if (n.p.exitCode !== null || n.p.signalCode !== null) return r();
              n.p.once("exit", r);
              n.p.kill("SIGTERM");
              setTimeout(() => {
                n.p.kill("SIGKILL");
                r();
              }, 15_000).unref();
            }),
        ),
      );
    },
  };
}

/** Closed-loop load; every acknowledged value per counter, latencies, errors. */
async function load(c, { until, names = NAMES, clients = CLIENTS, onAck }) {
  const acks = new Map();
  const lat = [];
  const byNode = new Map(); // node name -> latencies of the requests that entered there
  const errors = {};
  await Promise.all(
    Array.from({ length: clients }, async () => {
      while (!until()) {
        const name = `k${Math.floor(Math.random() * names)}`;
        const live = c.nodes.filter((n) => !n.dead);
        const node = live[Math.floor(Math.random() * live.length)];
        const t = performance.now();
        try {
          const r = await fetch(`${node.base}/increment?name=${name}`, {
            signal: AbortSignal.timeout(30_000),
          });
          const text = await r.text();
          if (r.status !== 200) throw new Error(`${r.status} ${text.slice(0, 100)}`);
          const ms = performance.now() - t;
          lat.push(ms);
          if (!byNode.has(node.name)) byNode.set(node.name, []);
          byNode.get(node.name).push(ms);
          const n = JSON.parse(text).n;
          if (!acks.has(name)) acks.set(name, []);
          acks.get(name).push(n);
          onAck?.(name, performance.now());
        } catch (e) {
          const k = `${node.kind}: ${String(e.message)
            .replace(/\[at .*/, "")
            .replace(/[0-9a-f]{64}/g, "<id>")
            .slice(0, 90)}`;
          errors[k] = (errors[k] ?? 0) + 1;
        }
      }
    }),
  );
  return { acks, lat, byNode, errors };
}

/** Values acknowledged twice, and counters whose next value does not follow every ack. */
async function verify(c, acks) {
  let twice = 0;
  let lost = 0;
  for (const [name, ns] of acks) {
    twice += ns.length - new Set(ns).size;
    let next;
    for (let i = 0; i < 60 && next === undefined; i++) {
      const live = c.nodes.filter((n) => !n.dead);
      const r = await fetch(`${live[i % live.length].base}/increment?name=${name}`).catch(
        () => undefined,
      );
      if (r?.status === 200) next = JSON.parse(await r.text()).n;
      else await sleep(500);
    }
    if (!(next > Math.max(...ns))) lost++;
  }
  return { valuesAckedTwice: twice, countersBehind: lost };
}

async function throughput() {
  const configs = (
    process.env.CONFIGS ??
    "celld=1;celld=2;celld=4;cellb=1;cellb=2;cellb=4;celld=1,cellb=1;celld=2,cellb=2"
  )
    .split(";")
    .map((s) =>
      Object.fromEntries(s.split(",").map((kv) => [kv.split("=")[0], Number(kv.split("=")[1])])),
    );
  const rows = [];
  for (const counts of configs) {
    const c = await cluster(counts);
    try {
      let warm = 400;
      await load(c, { until: () => warm-- <= 0 }); // every cell opened, its owner settled
      const cpu0 = c.nodes.map((n) => cpuSeconds(n.p.pid));
      const t0 = performance.now();
      const { acks, lat, errors } = await load(c, {
        until: () => performance.now() - t0 > DURATION_MS,
      });
      const secs = (performance.now() - t0) / 1000;
      const cpu = {};
      c.nodes.forEach((n, i) => {
        cpu[n.kind] = (cpu[n.kind] ?? 0) + cpuSeconds(n.p.pid) - cpu0[i];
      });
      lat.sort((a, b) => a - b);
      const nodes = (counts.celld ?? 0) + (counts.cellb ?? 0);
      const row = {
        celld: counts.celld ?? 0,
        cellb: counts.cellb ?? 0,
        requests: lat.length,
        rps: round(lat.length / secs, 0),
        p50Ms: round(pct(lat, 0.5)),
        p90Ms: round(pct(lat, 0.9)),
        p99Ms: round(pct(lat, 0.99)),
        crossNodeShare: round((nodes - 1) / nodes, 2),
        cpuSecondsPer1kRequests: Object.fromEntries(
          Object.entries(cpu).map(([k, v]) => [k, round((v / lat.length) * 1000, 2)]),
        ),
        owners: await c.owners(),
        errors,
        ...(await verify(c, acks)),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    } finally {
      await c.close();
    }
  }
  return rows;
}

async function failover(signal) {
  const out = [];
  for (const victim of ["cellb", "celld"]) {
    const c = await cluster({ celld: 2, cellb: 2 });
    try {
      let warm = 400;
      await load(c, { until: () => warm-- <= 0, names: 40 });
      const lastAck = new Map();
      let killedAt = 0;
      const gaps = new Map(); // name -> first ack after the kill
      const t0 = performance.now();
      const run = load(c, {
        names: 40,
        until: () => performance.now() - t0 > (signal === "SIGKILL" ? 30_000 : 10_000),
        onAck: (name, t) => {
          if (killedAt && t > killedAt && !gaps.has(name)) gaps.set(name, t - killedAt);
          lastAck.set(name, t);
        },
      });
      await sleep(3_000);
      const n = c.nodes.find((x) => x.kind === victim);
      n.dead = true;
      killedAt = performance.now();
      n.p.kill(signal);
      const { acks, errors } = await run;
      const g = [...gaps.values()].sort((a, b) => a - b);
      const row = {
        signal,
        victim,
        countersAnsweringAgain: `${g.length}/40`,
        unavailableMsMax: round(g.at(-1) ?? 0, 0),
        unavailableMsP50: round(pct(g, 0.5), 0),
        failedRequests: Object.values(errors).reduce((a, b) => a + b, 0),
        errors,
        ...(await verify(c, acks)),
      };
      out.push(row);
      console.log(JSON.stringify(row));
    } finally {
      await c.close();
    }
  }
  return out;
}

const percentiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p50Ms: round(pct(s, 0.5)),
    p90Ms: round(pct(s, 0.9)),
    p99Ms: round(pct(s, 0.99)),
    p999Ms: round(pct(s, 0.999)),
    maxMs: round(s.at(-1) ?? 0),
  };
};

async function scale() {
  const sizes = (process.env.SCALE_NODES ?? "4,6,8,10").split(",").map(Number);
  const clients = Number(process.env.SCALE_CLIENTS ?? 128);
  const rows = [];
  for (const size of sizes) {
    const c = await cluster({ cellb: size });
    try {
      let warm = 1_000;
      await load(c, { until: () => warm-- <= 0, clients }); // every cell opened, owners settled
      const cpu0 = c.nodes.map((n) => cpuSeconds(n.p.pid));
      // What else shares the machine: this process (the clients) and the S3 server.
      const rustfs = Number(
        execFileSync("pgrep", ["-o", "rustfs"], { encoding: "utf8" }).trim() || 0,
      );
      const client0 = process.cpuUsage();
      const rustfs0 = rustfs ? cpuSeconds(rustfs) : 0;
      const mem = c.nodes.map(() => []);
      const sampler = setInterval(() => {
        for (const [i, n] of c.nodes.entries()) mem[i].push(rssMB(n.p.pid));
      }, 500);
      const t0 = performance.now();
      const { acks, lat, byNode, errors } = await load(c, {
        clients,
        until: () => performance.now() - t0 > DURATION_MS,
      });
      clearInterval(sampler);
      const secs = (performance.now() - t0) / 1000;
      const client = process.cpuUsage(client0);
      const machine = {
        clientCpuShare: round((client.user + client.system) / 1e6 / secs, 2),
        s3CpuShare: rustfs ? round((cpuSeconds(rustfs) - rustfs0) / secs, 2) : null,
      };
      const owned = await c.ownersByNode();
      const nodes = c.nodes.map((n, i) => {
        const l = byNode.get(n.name) ?? [];
        const m = mem[i];
        return {
          node: n.name.replace(/^cellb-bench-[^-]+-[^-]+-/, "cellb-"),
          requests: l.length,
          ...percentiles(l),
          cpuSeconds: round(cpuSeconds(n.p.pid) - cpu0[i], 2),
          cpuShare: round((cpuSeconds(n.p.pid) - cpu0[i]) / secs, 2),
          rssMBAvg: round(m.reduce((a, b) => a + b, 0) / Math.max(1, m.length), 0),
          rssMBPeak: round(Math.max(0, ...m), 0),
          cellsOwned: owned[n.name] ?? 0,
        };
      });
      const row = {
        nodes: size,
        clients,
        requests: lat.length,
        rps: round(lat.length / secs, 0),
        ...percentiles(lat),
        cpuSecondsPer1kRequests: round(
          (nodes.reduce((a, n) => a + n.cpuSeconds, 0) / lat.length) * 1000,
          2,
        ),
        rssMBTotalPeak: round(
          nodes.reduce((a, n) => a + n.rssMBPeak, 0),
          0,
        ),
        nodesCpuShare: round(
          nodes.reduce((a, n) => a + n.cpuShare, 0),
          2,
        ),
        ...machine,
        cellsOwned: Object.values(owned).reduce((a, b) => a + b, 0),
        errors,
        ...(await verify(c, acks)),
        perNode: nodes,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    } finally {
      await c.close();
    }
  }
  return rows;
}

const all = {
  scale,
  throughput,
  failover: () => failover("SIGKILL"),
  leave: () => failover("SIGTERM"),
};
const chosen = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(all).filter((k) => k !== "scale");
const results = {
  date: new Date().toISOString(),
  machine: {
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
  },
  celld: execFileSync(CELLD, ["--version"]).toString().trim(),
  bucket: "RustFS on 127.0.0.1",
  load: { clients: CLIENTS, names: NAMES, durationMs: DURATION_MS },
  cellbDurability: process.env.DURABILITY ?? "fleet",
};
for (const s of chosen) results[s] = await all[s]();
if (process.env.BENCH_JSON)
  writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
