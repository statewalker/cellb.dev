// Lifo in single-use workers (Node): warm-up, memory per worker, and release on terminate.
//   node bench/lifo-workers-node.ts [size]
import { Worker } from "node:worker_threads";
import { createIsolatedPool } from "../src/isolated-pool.ts";
import { pssMb, threads } from "./proc.ts";

const size = Number(process.argv[2] ?? 4);
const base = pssMb();
const pool = createIsolatedPool({
  spawn: () => new Worker(new URL("../test/fixtures/isolated-lifo-worker.ts", import.meta.url)),
  image: { packages: [] },
  size,
});
let t = performance.now();
await pool.ready();
console.log(
  `warm ${size}: ${Math.round(performance.now() - t)} ms; pss ${pssMb() - base} MB over baseline (${Math.round((pssMb() - base) / size)} MB each), threads ${threads()}`,
);
const runs: number[] = [];
for (let i = 0; i < 10; i++) {
  t = performance.now();
  const r = await pool.run({ argv: ["node", "-e", "console.log([1,2,3].map(x=>x*2).join())"] });
  runs.push(Math.round(performance.now() - t));
  if (r.exitCode !== 0) console.log("failed", r.stderr);
}
console.log(`run (acquire + exec + terminate), ms: ${runs.join(", ")}`);
const before = pssMb();
await pool.close();
console.log(`close: pss ${before} -> ${pssMb()} MB at once`);
await new Promise((r) => setTimeout(r, 500));
console.log(`+500 ms: pss ${pssMb()} MB, threads ${threads()}`);
process.exit(0);
