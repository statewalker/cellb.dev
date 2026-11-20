// The spread probe on Node (statewalker/statewalker-root#177): the project of probes/spread/project
// over worker threads, wired as startProjectShards wires browser workers. Measures how tasks share
// out, how many threads start, how much they store, and cells logged to the host's FilesApi.
//
//   pnpm probes:spread-node [tasks|threads|volume|backup ...]     (all by default)
//   SPREAD_THREADS=1,2,4,8  SPREAD_STEPS=16,32,64,128,256,512  SPREAD_VOLUME_MB=4096
//   SPREAD_BACKUP_MB=512  SPREAD_JSON=<dir>  SPREAD_RESERVE_MB=2048
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { serveFilesApi } from "../../src/ltx/files-rpc.ts";
import { parseJsonc } from "../../src/project/jsonc.ts";
import { connectRuntime } from "../../src/transport/port.ts";

const shardScript = process.env.SPREAD_SHARD_SCRIPT!;
const projectDir = resolve(process.env.SPREAD_PROJECT_DIR!);
const config = parseJsonc(readFileSync(join(projectDir, "wrangler.jsonc"), "utf8"));
const reserveMB = Number(process.env.SPREAD_RESERVE_MB ?? 2_048);
const list = (v: string | undefined, d: number[]) => (v ? v.split(",").map(Number) : d);
const availableMB = () => {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return Math.round(Number(m?.[1]) / 1024);
  } catch {
    return Math.round(freemem() / 2 ** 20);
  }
};
const rssMB = () => Math.round(process.memoryUsage().rss / 2 ** 20);
const du = (dir: string) => Number(execFileSync("du", ["-sb", dir]).toString().split("\t")[0]);

interface Node {
  threads: number;
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

/** `threads` worker threads running the project together; cells under `dataDir/t<i>`. */
async function start(threads: number, dataDir: string, hostFiles?: NodeFilesApi): Promise<Node> {
  const workers = Array.from({ length: threads }, (_, i) => {
    const dir = join(dataDir, `t${i}`);
    mkdirSync(dir, { recursive: true });
    return new Worker(shardScript, { workerData: { shard: i, shards: threads, dir, config } });
  });
  const ask = (w: Worker, msg: Record<string, unknown>, transfer: any[]) =>
    new Promise<any>((done) => {
      const { port1, port2 } = new MessageChannel();
      port1.once("message", (r) => {
        port1.close();
        done(r);
      });
      w.postMessage({ ...msg, reply: port2 }, [port2, ...transfer]);
    });
  const peers = workers.map(() => [] as { shard: number; role: string; port: any }[]);
  for (let i = 0; i < threads; i++)
    for (let j = 0; j < threads; j++) {
      if (i === j) continue;
      const { port1, port2 } = new MessageChannel();
      peers[i].push({ shard: j, role: "link", port: port1 });
      peers[j].push({ shard: i, role: "serve", port: port2 });
    }
  const ingress = workers.map(() => new MessageChannel());
  const stops: (() => void)[] = [];
  const started = await Promise.all(
    workers.map((w, i) => {
      let files: any;
      if (hostFiles) {
        const ch = new MessageChannel();
        stops.push(serveFilesApi(ch.port1 as any, hostFiles));
        files = ch.port2;
      }
      return ask(w, { peers: peers[i], ingress: ingress[i].port2, files }, [
        ingress[i].port2,
        ...peers[i].map((p) => p.port),
        ...(files ? [files] : []),
      ]);
    }),
  );
  const failed = started.find((r) => !r.ok);
  if (failed) {
    for (const w of workers) await w.terminate();
    throw new Error(failed.error);
  }
  const remotes = await Promise.all(ingress.map((c) => connectRuntime(c.port1 as any)));
  let next = 0;
  return {
    threads,
    fetch: (req) => remotes[next++ % remotes.length].fetch(req),
    async close() {
      await Promise.all(remotes.map((r) => r.close()));
      await Promise.all(workers.map((w) => ask(w, { type: "close" }, [])));
      for (const stop of stops) stop();
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

async function runTasks(
  node: Node,
  opts: { names: string[]; rounds: number; kb: number; work: number; concurrency?: number },
) {
  const queue: string[] = [];
  for (let r = 0; r < opts.rounds; r++) queue.push(...opts.names);
  const perWorker: Record<string, number> = {};
  const errors: string[] = [];
  let done = 0;
  const t0 = performance.now();
  const loop = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift())
      try {
        const res = await node.fetch(
          new Request(`http://spread/task?name=${name}&kb=${opts.kb}&work=${opts.work}`),
        );
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        const r = (await res.json()) as { worker: string };
        perWorker[r.worker] = (perWorker[r.worker] ?? 0) + 1;
        done++;
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err).slice(0, 300));
        if (errors.length >= 20) queue.length = 0;
      }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 64 }, loop));
  const ms = performance.now() - t0;
  return {
    tasks: done,
    ms: Math.round(ms),
    tasksPerSec: Math.round((done * 1000) / ms),
    mbPerSec: Math.round(((done * opts.kb) / 1024 / (ms / 1000)) * 10) / 10,
    workersUsed: Object.keys(perWorker).length,
    errors: errors.slice(0, 5),
    errorCount: errors.length,
  };
}

async function objectStats(node: Node, names: string[]) {
  let rows = 0;
  let bytes = 0;
  let movedObjects = 0;
  for (const name of names) {
    const s = (await (
      await node.fetch(new Request(`http://spread/stats?name=${name}`))
    ).json()) as any;
    rows += s.n;
    bytes += s.bytes;
    if (s.workers > 1) movedObjects++;
  }
  return { rows, bytes, movedObjects };
}

const objects = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const machine = {
  cpus: cpus().length,
  cpu: cpus()[0]?.model,
  totalMB: Math.round(totalmem() / 2 ** 20),
  node: process.version,
};
const root = mkdtempSync(join(process.env.SPREAD_DATA ?? tmpdir(), "spread-node-"));

function save(name: string, result: object) {
  const full = { date: new Date().toISOString().slice(0, 10), machine, ...result };
  console.log(JSON.stringify(full, null, 2));
  if (process.env.SPREAD_JSON) {
    mkdirSync(process.env.SPREAD_JSON, { recursive: true });
    writeFileSync(
      join(process.env.SPREAD_JSON, `node-${name}.json`),
      `${JSON.stringify(full, null, 2)}\n`,
    );
  }
}

const experiments: Record<string, () => Promise<void>> = {
  async tasks() {
    const rows: any[] = [];
    for (const threads of list(process.env.SPREAD_THREADS, [1, 2, 4, 8])) {
      const t = performance.now();
      const node = await start(threads, join(root, `tasks-${threads}`));
      const startMs = Math.round(performance.now() - t);
      const names = objects(64, `w${threads}-o`);
      const cpu = await runTasks(node, { names, rounds: 8, kb: 4, work: 2_000_000 });
      const io = await runTasks(node, { names, rounds: 4, kb: 256, work: 0 });
      const stats = await objectStats(node, names);
      await node.close();
      rows.push({ threads, startMs, cpu, io, stats, rssMB: rssMB() });
      console.log(JSON.stringify(rows.at(-1)));
    }
    save("tasks", { test: "tasks shared by threads", rows });
  },

  async threads() {
    const rows: any[] = [];
    let stopped = "all steps passed";
    let perThreadMB = 40; // refined from each step's RSS
    for (const threads of list(process.env.SPREAD_STEPS, [16, 32, 64, 128, 256, 384, 512])) {
      // The next step would take threads × perThreadMB: stop before the machine (or the
      // container's memory limit) kills the process.
      if (availableMB() + rssMB() < reserveMB + threads * perThreadMB) {
        stopped = `machine memory: ${availableMB()} MB left before ${threads} threads`;
        break;
      }
      const t = performance.now();
      let node: Node | undefined;
      try {
        node = await start(threads, join(root, `threads-${threads}`));
        const startMs = Math.round(performance.now() - t);
        const run = await runTasks(node, {
          names: objects(threads * 4, `m${threads}-o`),
          rounds: 2,
          kb: 1,
          work: 0,
        });
        rows.push({
          threads,
          ok: run.errorCount === 0,
          startMs,
          run,
          rssMB: rssMB(),
          availableMB: availableMB(),
        });
        perThreadMB = Math.max(perThreadMB, Math.ceil(rssMB() / threads));
      } catch (err) {
        rows.push({
          threads,
          ok: false,
          error: String((err as Error)?.message ?? err).slice(0, 300),
        });
      }
      console.log(JSON.stringify(rows.at(-1)));
      await node?.close().catch(() => {});
      if (!rows.at(-1).ok) {
        stopped = rows.at(-1).error ?? rows.at(-1).run?.errors?.[0];
        break;
      }
    }
    save("threads", { test: "how many threads", stopped, rows });
  },

  async volume() {
    const maxMB = Number(process.env.SPREAD_VOLUME_MB ?? 4_096);
    const threads = 4;
    const dir = join(root, "volume");
    const node = await start(threads, dir);
    const names = objects(64, "vol-o");
    const rows: any[] = [];
    let stopped = `reached ${maxMB} MB`;
    for (let written = 0; written < maxMB; written += 256) {
      const run = await runTasks(node, { names, rounds: 4, kb: 1024, work: 0, concurrency: 16 });
      rows.push({
        writtenMB: written + 256,
        run,
        diskMB: Math.round(du(dir) / 2 ** 20),
        rssMB: rssMB(),
      });
      console.log(JSON.stringify(rows.at(-1)));
      if (run.errorCount) {
        stopped = run.errors[0];
        break;
      }
    }
    const stats = await objectStats(node, names);
    await node.close();
    save("volume", { test: "stored volume", threads, stopped, stats, rows });
    rmSync(dir, { recursive: true, force: true });
  },

  async backup() {
    const totalMB = Number(process.env.SPREAD_BACKUP_MB ?? 512);
    const hostDir = join(root, "host-folder");
    mkdirSync(hostDir, { recursive: true });
    // The host's FilesApi: a local folder here; an S3 FilesApi has the same interface.
    const host = new NodeFilesApi({ rootDir: hostDir });
    const names = objects(64, "b-o");
    const rounds = Math.max(1, Math.round((totalMB * 1024) / 256 / names.length));
    let t = performance.now();
    const a = await start(4, join(root, "backup-4"), host);
    const write = await runTasks(a, { names, rounds, kb: 256, work: 0, concurrency: 16 });
    const before = await objectStats(a, names);
    await a.close();
    const writeMs = Math.round(performance.now() - t);
    const hostBytes = du(hostDir);
    // 8 threads with EMPTY local directories: the cells come back from the host's folder alone.
    t = performance.now();
    const b = await start(8, join(root, "backup-8"), host);
    const after = await objectStats(b, names);
    const more = await runTasks(b, { names, rounds: 1, kb: 4, work: 0 });
    await b.close();
    save("backup", {
      test: "cells logged to the host's FilesApi, re-sharded",
      write,
      writeMs,
      before,
      hostMB: Math.round(hostBytes / 2 ** 20),
      reopenMs: Math.round(performance.now() - t),
      after,
      more,
    });
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(experiments);
try {
  for (const name of wanted) await experiments[name]();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
