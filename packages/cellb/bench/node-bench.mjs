#!/usr/bin/env node
// cellb's numbers on Node, measured the way celld.dev reports its own: durability (one writer,
// acknowledged writes after a SIGKILL, durable write latency, failover), speed (stateless
// requests, waking a hibernated cell) and density (RAM per resident cell).
//
//   pnpm build && node --expose-gc bench/node-bench.mjs            # every scenario
//   node --expose-gc bench/node-bench.mjs stateless wake           # some of them
//   BENCH_JSON=out.json node --expose-gc bench/node-bench.mjs      # also write the results
//
// Every scenario runs in a child process of its own, so one does not warm, load or leak into the
// next. It imports the built package (dist/), as a user of the published package would.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const { createCellRuntime, DurableObject, celldBucket, memoryObjectStore } = await import(
  new URL("index.js", dist).href
);
const { nodeSqliteOpener, sqliteObjectStore } = await import(new URL("node.js", dist).href);

// --- The Worker every scenario runs -------------------------------------------------------------

class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS w (seq INTEGER PRIMARY KEY, at INTEGER)");
  }
  write(seq) {
    this.ctx.storage.sql.exec("INSERT INTO w (seq, at) VALUES (?, ?)", seq, Date.now());
    return seq;
  }
  read() {
    return this.ctx.storage.sql
      .exec("SELECT count(*) AS n, coalesce(max(seq), 0) AS top FROM w")
      .one();
  }
  seqs() {
    return this.ctx.storage.sql
      .exec("SELECT seq FROM w ORDER BY seq")
      .toArray()
      .map((r) => r.seq);
  }
}

const worker = {
  Counter,
  default: {
    async fetch(req, env) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response("ok");
      const [, , name, op, arg] = url.pathname.split("/"); // /cell/<name>/<op>/<arg>
      const cell = env.COUNTER.getByName(name);
      if (op === "write") return Response.json(await cell.write(Number(arg)));
      if (op === "read") return Response.json(await cell.read());
      if (op === "seqs") return Response.json(await cell.seqs());
      return new Response("not found", { status: 404 });
    },
  },
};

const runtimeWith = (opts) =>
  createCellRuntime({ worker, durableObjects: { COUNTER: { className: "Counter" } }, ...opts });

// --- Helpers ------------------------------------------------------------------------------------

const now = () => performance.now();
const tmp = () => mkdtempSync(join(os.tmpdir(), "cellb-bench-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const stats = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: q(s, 0.5),
    p99: q(s, 0.99),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
const round = (x, d = 3) => Number(x.toFixed(d));
const get = (rt, path) => rt.fetch(new Request(`http://bench${path}`));
const mb = (bytes) => bytes / 1024 / 1024;
const gc = () => {
  globalThis.gc?.();
  globalThis.gc?.();
};

/** A bucket that waits `ms` before each operation: a stand-in for an object store's round trip. */
function slowStore(store, ms) {
  const delayed =
    (op) =>
    async (...args) => {
      if (ms) await sleep(ms);
      return store[op](...args);
    };
  return {
    get: delayed("get"),
    put: delayed("put"),
    list: delayed("list"),
    delete: delayed("delete"),
  };
}

// --- Scenarios (each runs in a child) -----------------------------------------------------------

const scenarios = {
  /** Stateless requests: in-process runtime.fetch, then over loopback HTTP from another process. */
  async stateless() {
    const rt = runtimeWith({ openSql: nodeSqliteOpener() });
    for (let i = 0; i < 5_000; i++) await (await get(rt, "/")).text();
    const inproc = [];
    for (let i = 0; i < 50_000; i++) {
      const t = now();
      await (await get(rt, "/")).text();
      inproc.push(now() - t);
    }
    const t0 = now();
    let n = 0;
    await Promise.all(
      Array.from({ length: 64 }, async () => {
        while (now() - t0 < 3_000) {
          await (await get(rt, "/")).text();
          n++;
        }
      }),
    );
    const inprocRps = n / ((now() - t0) / 1000);

    const server = http.createServer(async (req, res) => {
      const r = await rt.fetch(new Request(`http://bench${req.url}`, { method: req.method }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const client = await child("http-client", { BENCH_PORT: String(port) });
    server.close();
    await rt.close();
    return {
      inProcess: { ...mapStats(stats(inproc)), rps: Math.round(inprocRps) },
      http: client,
    };
  },

  /** Waking a hibernated cell: the instance is dropped; the database stays open, or is closed. */
  async wake() {
    const dir = tmp();
    const N = 1_000;
    const out = {};
    for (const closeDb of [false, true]) {
      const rt = runtimeWith({
        openSql: nodeSqliteOpener(dir),
        hibernateAfterMs: 3_600_000, // enables the sweep machinery; the bench hibernates by hand
        ...(closeDb ? { closeDatabaseAfterMs: 1 } : {}),
      });
      const tag = closeDb ? "c" : "o";
      for (let i = 0; i < N; i++) await (await get(rt, `/cell/${tag}${i}/write/1`)).text();
      await sleep(20);
      const slept = rt.hibernateIdle(0);
      const ms = [];
      for (let i = 0; i < N; i++) {
        const t = now();
        const r = await (await get(rt, `/cell/${tag}${i}/read`)).json();
        ms.push(now() - t);
        if (r.n !== 1) throw new Error(`cell ${tag}${i} lost its row: ${JSON.stringify(r)}`);
      }
      out[closeDb ? "databaseClosed" : "databaseOpen"] = {
        hibernated: slept,
        ...mapStats(stats(ms)),
      };
      await rt.close();
    }
    rmSync(dir, { recursive: true, force: true });

    // An inactive cell: only in the bucket. A new runtime restores it on first use.
    const store = memoryObjectStore();
    const a = runtimeWith({
      openSql: nodeSqliteOpener(),
      storage: celldBucket(store, { node: "a" }),
    });
    for (let i = 0; i < 200; i++) await (await get(a, `/cell/i${i}/write/1`)).text();
    await a.close();
    const b = runtimeWith({
      openSql: nodeSqliteOpener(),
      storage: celldBucket(store, { node: "b" }),
    });
    const cold = [];
    for (let i = 0; i < 200; i++) {
      const t = now();
      const r = await (await get(b, `/cell/i${i}/read`)).json();
      cold.push(now() - t);
      if (r.n !== 1) throw new Error(`restored cell i${i}: ${JSON.stringify(r)}`);
    }
    await b.close();
    out.inactiveFromBucket = {
      note: "in-memory bucket: cellb's own cost, no network",
      ...mapStats(stats(cold)),
    };
    return out;
  },

  /** RAM per resident cell: RSS and V8 heap grown by N live cells, each with a table and a row. */
  async memory() {
    const dir = tmp();
    const N = Number(process.env.BENCH_CELLS ?? 5_000);
    const rt = runtimeWith({ openSql: nodeSqliteOpener(dir) });
    await (await get(rt, "/cell/warm/write/1")).text();
    gc();
    await sleep(200);
    const before = process.memoryUsage();
    for (let i = 0; i < N; i++) await (await get(rt, `/cell/m${i}/write/1`)).text();
    gc();
    await sleep(200);
    const after = process.memoryUsage();
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
    const rss = (after.rss - before.rss) / N;
    return {
      cells: N,
      rssPerCellMB: round(mb(rss)),
      heapPerCellMB: round(mb((after.heapUsed - before.heapUsed) / N)),
      residentCellsPer8GB: Math.floor((8 * 1024 * 1024 * 1024 * 0.8) / rss),
    };
  },

  /** Durable write latency: each write waits for its LTX upload (one bucket round trip). */
  async durable() {
    const out = {};
    const dir = tmp();
    for (const [rtt, pageCapture] of [
      [0, false],
      [0, true],
      [20, true],
      [90, true],
    ]) {
      const store = slowStore(memoryObjectStore(), rtt);
      // pageCapture reads a commit's pages from the WAL; without it the log diffs the image.
      const local = join(dir, `${rtt}-${pageCapture}`);
      mkdirSync(local);
      const rt = runtimeWith({
        openSql: pageCapture ? nodeSqliteOpener(local, { pageCapture }) : nodeSqliteOpener(),
        storage: celldBucket(store, { node: "w" }),
      });
      await (await get(rt, "/cell/d/write/0")).text(); // takes the cell, first snapshot
      const ms = [];
      const n = rtt ? 100 : 2_000;
      for (let i = 1; i <= n; i++) {
        const t = now();
        await (await get(rt, `/cell/d/write/${i}`)).text();
        ms.push(now() - t);
      }
      // Writes to many cells at once: the commits of different cells upload in parallel.
      const t0 = now();
      await Promise.all(
        Array.from({ length: 100 }, (_, c) => get(rt, `/cell/p${c}/write/1`).then((r) => r.text())),
      );
      const parallel = now() - t0;
      await rt.close();
      out[`bucketRtt${rtt}ms${pageCapture ? "" : "ImageDiff"}`] = {
        ...mapStats(stats(ms)),
        parallel100CellsMs: round(parallel, 1),
      };
    }
    rmSync(dir, { recursive: true, force: true });
    return out;
  },

  /**
   * SIGKILL a node in the middle of a write stream, delete its local database, and let a second
   * node with no local state take the cell over from the bucket: every acknowledged write must be
   * there, and the second node must not get the cell while the first one's lease is live.
   */
  async failover() {
    const dir = tmp();
    const bucket = join(dir, "bucket.sqlite3");
    const ttl = Number(process.env.BENCH_LEASE_TTL_MS ?? 10_000);
    const writer = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", SELF, "--child", "writer"],
      {
        env: {
          ...process.env,
          BENCH_BUCKET: bucket,
          BENCH_LOCAL: join(dir, "a"),
          BENCH_LEASE_TTL_MS: String(ttl),
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let acked = 0;
    const lines = createInterface({ input: writer.stdout });
    await new Promise((resolve) => {
      lines.on("line", (l) => {
        if (l.startsWith("ack ")) acked = Number(l.slice(4));
        if (acked >= 300) resolve();
      });
    });
    writer.kill("SIGKILL");
    const killedAt = now();
    rmSync(join(dir, "a"), { recursive: true, force: true }); // recovery comes only from the bucket

    const b = runtimeWith({
      openSql: nodeSqliteOpener(),
      storage: celldBucket(sqliteObjectStore(bucket), { node: "b", leaseTtlMs: ttl }),
    });
    let refused = 0;
    let seqs;
    for (;;) {
      const r = await get(b, "/cell/stream/seqs");
      if (r.ok) {
        seqs = await r.json();
        break;
      }
      await r.text();
      refused++;
      await sleep(100);
    }
    const failoverMs = now() - killedAt;
    await b.close();
    rmSync(dir, { recursive: true, force: true });
    const have = new Set(seqs);
    let lost = 0;
    for (let i = 1; i <= acked; i++) if (!have.has(i)) lost++;
    return {
      leaseTtlMs: ttl,
      acknowledged: acked,
      recovered: seqs.length,
      lostAcknowledged: lost,
      refusedWhileLeaseLive: refused,
      failoverMs: Math.round(failoverMs),
    };
  },
};

/** Children that are not scenarios: the HTTP load generator, and the node the failover kills. */
const helpers = {
  async "http-client"() {
    const port = Number(process.env.BENCH_PORT);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
    const once = () =>
      new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
            res.resume();
            res.on("end", resolve);
          })
          .on("error", reject);
      });
    for (let i = 0; i < 2_000; i++) await once();
    const ms = [];
    for (let i = 0; i < 10_000; i++) {
      const t = now();
      await once();
      ms.push(now() - t);
    }
    const t0 = now();
    let n = 0;
    await Promise.all(
      Array.from({ length: 64 }, async () => {
        while (now() - t0 < 5_000) {
          await once();
          n++;
        }
      }),
    );
    agent.destroy();
    return { ...mapStats(stats(ms)), rps: Math.round(n / ((now() - t0) / 1000)), connections: 64 };
  },

  async writer() {
    mkdirSync(process.env.BENCH_LOCAL, { recursive: true });
    const rt = runtimeWith({
      openSql: nodeSqliteOpener(process.env.BENCH_LOCAL),
      storage: celldBucket(sqliteObjectStore(process.env.BENCH_BUCKET), {
        node: "a",
        leaseTtlMs: Number(process.env.BENCH_LEASE_TTL_MS),
      }),
    });
    for (let i = 1; ; i++) {
      const r = await get(rt, `/cell/stream/write/${i}`);
      if (!r.ok) throw new Error(`write ${i}: ${r.status} ${await r.text()}`);
      await r.text();
      process.stdout.write(`ack ${i}\n`); // only after the response: the write is durable
    }
  },
};

const mapStats = (s) => ({
  n: s.n,
  p50Ms: round(s.p50),
  p99Ms: round(s.p99),
  meanMs: round(s.mean),
});

/** Runs a scenario or helper in a child process and returns what it printed as its result. */
function child(name, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ["--expose-gc", "--disable-warning=ExperimentalWarning", SELF, "--child", name],
      {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("result "));
      if (code === 0 && line) resolve(JSON.parse(line.slice(7)));
      else reject(new Error(`${name} exited with ${code}`));
    });
  });
}

// --- Main ---------------------------------------------------------------------------------------

if (process.argv[2] === "--child") {
  const name = process.argv[3];
  const fn = scenarios[name] ?? helpers[name];
  const result = await fn();
  process.stdout.write(`result ${JSON.stringify(result)}\n`);
  process.exit(0);
} else {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
  const results = {
    date: new Date().toISOString().slice(0, 10),
    machine: {
      cpu: os.cpus()[0]?.model.trim(),
      cpus: os.cpus().length,
      memoryGB: Math.round(os.totalmem() / 1024 ** 3),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
    },
  };
  for (const name of names) {
    process.stderr.write(`· ${name}…\n`);
    results[name] = await child(name);
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.BENCH_JSON)
    writeFileSync(process.env.BENCH_JSON, `${JSON.stringify(results, null, 2)}\n`);
}
