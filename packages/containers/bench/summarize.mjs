// Prints the capacity runs in bench/results as Markdown tables (for docs/capacity.md).
//   node bench/summarize.mjs
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("./results/", import.meta.url);
const runs = readdirSync(dir)
  .filter((f) => /capacity-.*\.json$/.test(f))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(f, dir), "utf8")) }));

const mem = (s) => s?.pssMb ?? s?.rendererMb;
console.log(
  "| Runtime | Image | Containers | Stopped because | Memory per container | Start (median) | Sweep of all, last step | Close |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const steps = r.steps;
  const last = steps.at(-1);
  const base = mem(r.baseline) ?? 0;
  const per = last ? Math.round((mem(last) - base) / last.n) : 0;
  const starts = steps.map((s) => s.startMs).sort((a, b) => a - b);
  const median = starts[Math.floor(starts.length / 2)];
  const close = r.closeMs
    ? `${Math.round((r.closeMs.engine + r.closeMs.project + r.closeMs.wasmer) / 1000)} s`
    : "";
  console.log(
    `| ${r.runtime} | ${r.example} | **${r.containers}** | ${r.stoppedBecause} | ${per} MB | ${median} ms | ${last?.sweepMs ?? ""} ms | ${close} |`,
  );
}
for (const r of runs) {
  console.log(`\n${r.runtime}, ${r.example}: n, memory (MB), threads, start (ms), sweep (ms)`);
  for (const s of r.steps.filter((s) => s.n === 1 || s.n % 10 === 0 || s === r.steps.at(-1)))
    console.log(
      `  ${s.n}\t${mem(s)}\t${s.threads ?? s.rendererThreads}\t${s.startMs}\t${s.sweepMs}`,
    );
}
