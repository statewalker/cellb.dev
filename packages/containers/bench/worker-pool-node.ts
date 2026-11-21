// Experiment: a pool of single-use workers, each with its own Wasmer client and one ready sandbox.
// A run takes a warm worker, executes a command, terminates the worker, and a new one is started.
// Measures warm-up, run latency, and whether terminating a worker gives its memory back at once.
//   node bench/worker-pool-node.ts [size] [runs]
import { Worker } from "node:worker_threads";
import { createContainer } from "../src/container.ts";
import { HostMounts, serveHostFiles } from "../src/files/bridge.ts";
import { connectEngine } from "../src/rpc.ts";
import { availableMb, pssMb, threads } from "./proc.ts";

const size = Number(process.argv[2] ?? 4);
const runs = Number(process.argv[3] ?? 8);
const mounts = new HostMounts();
const t0 = performance.now();
const now = () => Math.round(performance.now() - t0);
const log = (...a: unknown[]) => console.log(`${String(now()).padStart(6)} ms`, ...a);

async function warmWorker() {
  const started = performance.now();
  const worker = new Worker(new URL("../test/fixtures/pool-worker.ts", import.meta.url));
  const e = new MessageChannel();
  const f = new MessageChannel();
  serveHostFiles(f.port1, mounts);
  worker.postMessage({ engine: e.port2, files: f.port2 }, [e.port2 as never, f.port2 as never]);
  const engine = connectEngine(e.port1);
  const container = createContainer(engine, { packages: ["python/python"] });
  await container.start();
  // the first exec compiles the guest in this worker: do it while warming
  await container.exec(["python", "-c", "pass"]);
  return {
    worker,
    container,
    engine,
    ports: [e.port1, f.port1],
    warmMs: Math.round(performance.now() - started),
  };
}

const sample = (label: string) =>
  log(label.padEnd(28), `pss=${pssMb()}MB threads=${threads()} available=${availableMb()}MB`);
sample("baseline");
const warm = await Promise.all(Array.from({ length: size }, warmWorker));
log(`warmed ${size} workers in parallel; each: ${warm.map((w) => w.warmMs).join(", ")} ms`);
sample(`${size} warm workers`);

for (let i = 0; i < runs; i++) {
  const w = warm.shift()!;
  const t = performance.now();
  const r = await w.container.exec(["python", "-c", `print(sum(range(10**6)), ${i})`]);
  const runMs = Math.round(performance.now() - t);
  const tt = performance.now();
  await w.worker.terminate();
  for (const p of w.ports) p.close();
  const termMs = Math.round(performance.now() - tt);
  sample(`run ${i}: ${runMs} ms, terminate ${termMs} ms`);
  await new Promise((r) => setTimeout(r, 100));
  sample("  +100 ms");
  await new Promise((r) => setTimeout(r, 900));
  sample("  +1 s");
  if (r.exitCode !== 0) log("run failed", r.stderr);
  warm.push(await warmWorker().then((n) => (log(`  refilled in ${n.warmMs} ms`), n)));
}
await new Promise((r) => setTimeout(r, 4000));
sample("all runs done, +5 s");
for (const w of warm) await w.worker.terminate();
await new Promise((r) => setTimeout(r, 2000));
sample(`terminated the ${size} warm workers, +2 s`);
(globalThis as { gc?: () => void }).gc?.();
await new Promise((r) => setTimeout(r, 1000));
sample("after gc, +1 s");
process.exit(0);
