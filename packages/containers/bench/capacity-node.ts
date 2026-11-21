// How many containers one cellb node runs and keeps using, in Node.
//
// One cellb project, one container engine. Each step's first request to a new cell starts that
// cell's container; then every earlier cell is asked again and must answer from its own running
// container (startedMs 0: not restarted). The run stops at `max` containers, before the machine has
// less than `reserveMb` left, or at the first failure, and records what each step cost.
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { Wasmer } from "@wasmer/sdk/node";
import { provideContainerEngine, wasmerContainerEngine } from "../src/index.ts";
import { availableMb, pssMb, threads, totalMb } from "./proc.ts";

export interface CapacityStep {
  n: number;
  startMs: number;
  sweepMs: number;
  pssMb: number;
  threads: number;
  availableMb: number;
}
export interface CapacityRun {
  runtime: string;
  example: string;
  machine: { totalMb: number; cpus: number };
  baseline: { pssMb: number; threads: number };
  steps: CapacityStep[];
  stoppedBecause: string;
  containers: number;
  /** Closing the node: withdrawing the engine (destroys the containers), the project, the client. */
  closeMs?: { engine: number; project: number; wasmer: number };
}

export async function measureNodeCapacity(opts: {
  example: "python" | "php";
  max?: number;
  reserveMb?: number;
  log?: (s: CapacityStep) => void;
  teardown?: (s: string) => void;
}): Promise<CapacityRun> {
  const max = opts.max ?? 64;
  const reserveMb = opts.reserveMb ?? 2048;
  const wasmer = new Wasmer({
    cache: { directory: fileURLToPath(new URL("../.wasmer", import.meta.url)) },
  });
  const engine = wasmerContainerEngine(wasmer);
  const withdraw = provideContainerEngine(engine);
  const project = await loadProject(
    fileURLToPath(new URL(`../examples/${opts.example}`, import.meta.url)),
  );
  const get = async (cell: string) => {
    const res = await project.fetch(new Request(`http://localhost/cap?cell=${cell}`));
    if (res.status !== 200) throw new Error(`cell ${cell}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as {
      cell: string;
      startedMs?: number;
      fromContainer: { cell?: string };
    };
  };
  const { cpus } = await import("node:os");
  const run: CapacityRun = {
    runtime: `node ${process.version}`,
    example: opts.example,
    machine: { totalMb: totalMb(), cpus: cpus().length },
    baseline: { pssMb: pssMb(), threads: threads() },
    steps: [],
    stoppedBecause: `reached max (${max})`,
    containers: 0,
  };
  try {
    for (let n = 1; n <= max; n++) {
      if (availableMb() < reserveMb) {
        run.stoppedBecause = `less than ${reserveMb} MB left on the machine`;
        break;
      }
      let t = performance.now();
      try {
        const first = await get(`c${n}`);
        if (first.fromContainer.cell !== `c${n}`)
          throw new Error(`cell c${n} answered for ${first.fromContainer.cell}`);
      } catch (e) {
        run.stoppedBecause = `start ${n} failed: ${(e as Error).message.slice(0, 300)}`;
        break;
      }
      const startMs = Math.round(performance.now() - t);
      t = performance.now();
      let broken = "";
      for (let i = 1; i <= n && !broken; i++) {
        try {
          const r = await get(`c${i}`);
          if (r.startedMs !== 0) broken = `cell c${i} had to restart its container`;
        } catch (e) {
          broken = `cell c${i} stopped answering: ${(e as Error).message.slice(0, 200)}`;
        }
      }
      if (broken) {
        run.stoppedBecause = `after ${n} containers, ${broken}`;
        break;
      }
      const step = {
        n,
        startMs,
        sweepMs: Math.round(performance.now() - t),
        pssMb: pssMb(),
        threads: threads(),
        availableMb: availableMb(),
      };
      run.steps.push(step);
      run.containers = n;
      opts.log?.(step);
    }
  } finally {
    const lap = async (what: string, fn: () => Promise<unknown>) => {
      const t = performance.now();
      await fn();
      const ms = Math.round(performance.now() - t);
      opts.teardown?.(`${what}: ${ms} ms`);
      return ms;
    };
    const engineMs = await lap("engine withdrawn", withdraw);
    const projectMs = await lap("project closed", () => project.close());
    const wasmerMs = await lap("wasmer closed", () => wasmer.close());
    run.closeMs = { engine: engineMs, project: projectMs, wasmer: wasmerMs };
  }
  return run;
}
