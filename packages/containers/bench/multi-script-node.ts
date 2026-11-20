// N scripts at once in one Wasmer client, each in a sandbox of its own (its own files):
// how long they take together, and what each extra sandbox costs.
//   node bench/multi-script-node.ts quickjs|python|edgejs [N...]

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerContainerEngine } from "../src/engine.ts";
import { HostMounts, installHostFiles } from "../src/files/bridge.ts";
import { pssMb, threads } from "./proc.ts";

const runtime = process.argv[2] ?? "quickjs";
const ns = process.argv.slice(3).map(Number);
const work = 200; // ms of CPU per script
const images = {
  quickjs: {
    packages: ["wasmer/quickjs"],
    argv: ["qjs", "-e", `const t=Date.now(); while (Date.now()-t < ${work}); print("ok")`],
  },
  python: {
    packages: ["python/python"],
    argv: [
      "python",
      "-c",
      `import time\nt=time.time()\nwhile time.time()-t < ${work / 1000}: pass\nprint("ok")`,
    ],
  },
  edgejs: {
    packages: ["wasmer/edgejs"],
    argv: ["node", "-e", `const t=Date.now(); while (Date.now()-t < ${work}); console.log("ok")`],
  },
}[runtime as "quickjs"]!;

const wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
const engine = wasmerContainerEngine(wasmer);
const mounts = new HostMounts();
installHostFiles(mounts);
// warm: download and compile once
const w = await engine.start({ packages: images.packages });
await w.exec(images.argv);
await w.destroy();
const base = pssMb();
console.log(`${runtime}: client warm, pss ${base} MB, threads ${threads()}`);
console.log("N\tstart all (ms)\trun all (ms)\tvs one\tpss per sandbox (MB)\tthreads");
let one = 0;
for (const n of ns.length ? ns : [1, 2, 4, 8, 16, 32]) {
  const ids = Array.from({ length: n }, () => mounts.add(new MemFilesApi()));
  let t = performance.now();
  const hs = await Promise.all(
    ids.map((id) => engine.start({ packages: images.packages, mounts: [{ path: "/data", id }] })),
  );
  const startMs = Math.round(performance.now() - t);
  const pss = pssMb();
  t = performance.now();
  const rs = await Promise.all(hs.map((h) => h.exec(images.argv)));
  const runMs = Math.round(performance.now() - t);
  if (n === 1) one = runMs;
  const bad = rs.filter((r) => r.stdout.trim() !== "ok").length;
  console.log(
    `${n}\t${startMs}\t${runMs}\t${(runMs / one).toFixed(1)}x\t${Math.round((pss - base) / n)}\t${threads()}${bad ? `\t${bad} failed` : ""}`,
  );
  await Promise.all(hs.map((h) => h.destroy()));
  for (const id of ids) mounts.remove(id);
}
process.exit(0);
