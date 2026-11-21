// Start time of one-run containers: an isolated pool with slots = 1 (each container in a worker
// of its own, terminated when its script exits). For each runtime: the first containers (cold),
// a run when a container is ready, a run when none is (it waits for a refill), and a burst.
//   node bench/isolated-start-node.ts quickjs|python|edgejs [size] [runs]
import { Worker } from "node:worker_threads";
import { createIsolatedPool } from "../src/isolated-pool.ts";
import { pssMb } from "./proc.ts";

const runtime = process.argv[2] ?? "quickjs";
const size = Number(process.argv[3] ?? 2);
const runs = Number(process.argv[4] ?? 10);
const images = {
  quickjs: {
    image: { packages: ["wasmer/quickjs"] },
    warmup: ["qjs", "-e", "1"],
    argv: ["qjs", "-e", "print(6*7)"],
  },
  python: {
    image: { packages: ["python/python"] },
    warmup: ["python", "-c", "pass"],
    argv: ["python", "-c", "print(6*7)"],
  },
  edgejs: {
    image: { packages: ["wasmer/edgejs"] },
    warmup: ["node", "-e", "1"],
    argv: ["node", "-e", "console.log(6*7)"],
  },
}[runtime as "quickjs"]!;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (xs: number[]) =>
  `median ${median(xs)} ms (min ${Math.min(...xs)}, max ${Math.max(...xs)})`;

const base = pssMb();
const pool = createIsolatedPool({
  spawn: () => new Worker(new URL("../test/fixtures/isolated-wasmer-worker.ts", import.meta.url)),
  image: images.image,
  size,
  warmup: images.warmup,
});
let t = performance.now();
await pool.ready();
console.log(
  `${runtime}: ${size} containers ready (cold, in parallel) in ${Math.round(performance.now() - t)} ms; ${Math.round((pssMb() - base) / size)} MB each`,
);

// A run with a ready container: acquire + exec + terminate. Wait for the refill between runs.
const ready: number[] = [];
for (let i = 0; i < runs; i++) {
  await pool.ready();
  t = performance.now();
  const r = await pool.run({ argv: images.argv });
  ready.push(Math.round(performance.now() - t));
  if (r.stdout.trim() !== "42") throw new Error(`run failed: ${r.stdout} ${r.stderr}`);
}
console.log(`run with a ready container: ${fmt(ready)}`);

// The refill: how long until the pool is full again after a run.
const refill: number[] = [];
for (let i = 0; i < runs; i++) {
  await pool.ready();
  await pool.run({ argv: images.argv });
  t = performance.now();
  await pool.ready();
  refill.push(Math.round(performance.now() - t));
}
console.log(`refill after a run (a new worker, warmed): ${fmt(refill)}`);

// A run when no container is ready: it waits for one (empty the pool first).
const waiting: number[] = [];
for (let i = 0; i < Math.min(runs, 5); i++) {
  await pool.ready();
  const held = await Promise.all(Array.from({ length: size }, () => pool.acquire()));
  t = performance.now();
  const r = pool.run({ argv: images.argv });
  for (const c of held) await c.destroy();
  await r;
  waiting.push(Math.round(performance.now() - t));
}
console.log(`run when no container is ready (waits for a refill): ${fmt(waiting)}`);

// A burst: 4 x size runs at once.
await pool.ready();
t = performance.now();
const burst = await Promise.all(
  Array.from({ length: size * 4 }, () => pool.run({ argv: images.argv })),
);
console.log(
  `burst of ${size * 4} runs at once on ${size} ready: ${Math.round(performance.now() - t)} ms total, all ok: ${burst.every((r) => r.stdout.trim() === "42")}`,
);
await pool.close();
process.exit(0);
