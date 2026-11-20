// Capacity: how many containers one cellb node runs and keeps using in Chromium (Linux, /proc).
//   CONTAINERS_CAPACITY=1 pnpm e2e capacity
//   CAPACITY_MAX=64 CAPACITY_EXAMPLES=python,php BENCH_JSON=bench/results  (optional)
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { availableMb, chromiumPss, totalMb } from "../bench/proc.ts";

const enabled = !!process.env.CONTAINERS_CAPACITY && process.platform === "linux";
const examples = (process.env.CAPACITY_EXAMPLES ?? "python,php").split(",");
const max = Number(process.env.CAPACITY_MAX ?? 64);
const reserveMb = 2048;

async function ask(page: Page, msg: object) {
  return page.evaluate((m) => (window as any).__capacity(m), msg) as Promise<{
    status?: number;
    body?: string;
    error?: string;
  }>;
}

test.describe("container capacity of one cellb node (Chromium)", () => {
  test.skip(!enabled, "set CONTAINERS_CAPACITY=1 (Linux)");
  for (const example of examples) {
    test(`${example}: containers started from cells and all still answering`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(3_600_000);
      await page.goto("/");
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      const baseline = chromiumPss();
      const run = {
        runtime: `chromium ${browser.version()}`,
        example,
        machine: { totalMb: totalMb(), cpus: cpus().length },
        baseline,
        steps: [] as object[],
        stoppedBecause: `reached max (${max})`,
        containers: 0,
      };
      const get = async (cell: string) => {
        const r = await ask(page, { op: "get", cell, project: example });
        if (r.error || r.status !== 200)
          throw new Error(r.error ?? `HTTP ${r.status} ${r.body?.slice(0, 200)}`);
        return JSON.parse(r.body as string) as {
          startedMs: number;
          fromContainer: { cell?: string };
        };
      };
      for (let n = 1; n <= max; n++) {
        if (availableMb() < reserveMb) {
          run.stoppedBecause = `less than ${reserveMb} MB left on the machine`;
          break;
        }
        let t = Date.now();
        try {
          await get(`c${n}`);
        } catch (e) {
          run.stoppedBecause = `start ${n} failed: ${(e as Error).message.slice(0, 300)}`;
          break;
        }
        const startMs = Date.now() - t;
        t = Date.now();
        let broken = "";
        for (let i = 1; i <= n && !broken; i++) {
          try {
            if ((await get(`c${i}`)).startedMs !== 0)
              broken = `cell c${i} had to restart its container`;
          } catch (e) {
            broken = `cell c${i} stopped answering: ${(e as Error).message.slice(0, 200)}`;
          }
        }
        if (broken) {
          run.stoppedBecause = `after ${n} containers, ${broken}`;
          break;
        }
        const mem = chromiumPss();
        const step = { n, startMs, sweepMs: Date.now() - t, ...mem, availableMb: availableMb() };
        run.steps.push(step);
        run.containers = n;
        console.log(`[${example}] ${JSON.stringify(step)}`);
      }
      console.log(`[${example}] ${run.containers} containers; stopped: ${run.stoppedBecause}`);
      await ask(page, { op: "close" }).catch(() => {});
      if (process.env.BENCH_JSON) {
        mkdirSync(process.env.BENCH_JSON, { recursive: true });
        writeFileSync(
          join(process.env.BENCH_JSON, `chromium-capacity-${example}.json`),
          `${JSON.stringify(run, null, 2)}\n`,
        );
      }
      expect(run.containers).toBeGreaterThanOrEqual(Math.min(4, max));
    });
  }
});
