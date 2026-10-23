import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { loadNodeProject } from "../src/project/node-project.js";

const project = (maxConcurrency?: number) => {
  const dir = mkdtempSync(join(tmpdir(), "qconc-"));
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "q",
      main: "index.js",
      queues: {
        producers: [{ binding: "Q", queue: "jobs" }],
        consumers: [
          {
            queue: "jobs",
            max_batch_size: 1,
            max_batch_timeout: 0,
            max_concurrency: maxConcurrency,
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(dir, "index.js"),
    `let active = 0; globalThis.__peak = 0; globalThis.__done = 0; globalThis.__started = 0;
     export default {
       async fetch(req, env) { for (let i = 0; i < 6; i++) await env.Q.send(i); return new Response("ok"); },
       async queue(batch) {
         active++; globalThis.__peak = Math.max(globalThis.__peak, active);
         // held until all 6 started (or 300 ms): the peak counts the limit, not send timing
         const t0 = Date.now(); globalThis.__started = (globalThis.__started ?? 0) + 1;
         while (globalThis.__started < 6 && Date.now() - t0 < 300) await new Promise((r) => setTimeout(r, 5));
         active--; globalThis.__done += batch.messages.length;
       },
     };`,
  );
  return dir;
};

describe("P08e Queues max_concurrency", () => {
  for (const [conc, peak] of [
    // celld: unset means its ceiling (250), not 1 — consumer.maxConcurrency ?? limits.maxConcurrency
    [undefined, 6],
    [3, 3],
  ] as const) {
    it(`max_concurrency ${conc ?? "default (celld: 250)"} → at most ${peak} batch(es) in flight`, async () => {
      const g = globalThis as any;
      const { runtime } = await loadNodeProject(project(conc), {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
      });
      await runtime.fetch(new Request("http://q/"));
      for (let i = 0; i < 200 && g.__done < 6; i++) await new Promise((r) => setTimeout(r, 10));
      expect(g.__done).toBe(6);
      expect(g.__peak).toBe(peak);
    });
  }
});
