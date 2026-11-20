// Capacity: how many containers one cellb node runs and keeps using (Linux, reads /proc).
//   CONTAINERS_CAPACITY=1 pnpm vitest run test/capacity.test.ts
//   CAPACITY_MAX=64 CAPACITY_EXAMPLES=python,php BENCH_JSON=bench/results  (optional)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureNodeCapacity } from "../bench/capacity-node.ts";

const enabled = !!process.env.CONTAINERS_CAPACITY && process.platform === "linux";
const examples = (process.env.CAPACITY_EXAMPLES ?? "python,php").split(",") as ("python" | "php")[];
const max = Number(process.env.CAPACITY_MAX ?? 200);

describe.runIf(enabled)("container capacity of one cellb node (Node)", () => {
  for (const example of examples) {
    it(`${example}: containers started from cells and all still answering`, {
      timeout: 7_200_000,
    }, async () => {
      const run = await measureNodeCapacity({
        example,
        max,
        teardown: (s) => console.log(`[${example}] ${s}`),
        log: (s) =>
          console.log(
            `[${example}] n=${s.n} start=${s.startMs}ms sweep=${s.sweepMs}ms pss=${s.pssMb}MB threads=${s.threads} available=${s.availableMb}MB`,
          ),
      });
      console.log(`[${example}] ${run.containers} containers; stopped: ${run.stoppedBecause}`);
      if (process.env.BENCH_JSON) {
        mkdirSync(process.env.BENCH_JSON, { recursive: true });
        writeFileSync(
          join(process.env.BENCH_JSON, `node-capacity-${example}.json`),
          `${JSON.stringify(run, null, 2)}\n`,
        );
      }
      // A floor, not the measurement: the run itself is the result.
      expect(run.containers).toBeGreaterThanOrEqual(Math.min(8, max));
    });
  }
});
