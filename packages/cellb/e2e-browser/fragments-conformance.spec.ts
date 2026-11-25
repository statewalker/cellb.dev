import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";
import {
  alignBrowserDifferences,
  alignDocumentedDifferences,
  goldenDir,
} from "../conformance/scenarios.ts";

// Conformance with several projects in one browser realm (#191), as a fragment host's shard worker
// holds them: the projects of test/p62, each twice, side by side in one Dedicated Worker (each its
// own runtime and OPFS pool), their scenarios run at once. Every transcript must match celld's
// recording, as when the project runs alone (celld-projects.spec.ts).
const NAMES = [
  "counter",
  "rpc",
  "body",
  "storage-details",
  "d1-details",
  "kv-values",
  "queues-api",
  "sql-ingest",
  "vectordb",
  "worker-details",
];
const COPIES = ["one", "two"];

const golden = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, `../conformance/${goldenDir(name)}/${name}.json`),
      "utf8",
    ),
  );

test("celld examples side by side in one realm, each twice, answer as celld did", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const projects = Object.fromEntries(
    await Promise.all(NAMES.map(async (n) => [n, await bundleProjectForBrowser(n)] as const)),
  );
  await page.goto("/projects/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const jobs = NAMES.flatMap((name) =>
    COPIES.map((copy) => ({
      project: projects[name],
      scenario: name,
      pool: `fragments-${copy}-${name}-${stamp}`,
    })),
  );
  const results = (await page.evaluate((j) => (window as any).__runProjects(j), jobs)) as {
    ok: boolean;
    error?: string;
    transcript: unknown[];
  }[];
  for (const [i, job] of jobs.entries()) {
    const r = results[i];
    const label = `${job.pool}`;
    expect(r?.ok, `${label}: ${r?.error}`).toBe(true);
    const expected = golden(job.scenario).transcript;
    const aligned = alignDocumentedDifferences(r.transcript as never, expected);
    expect(alignBrowserDifferences(aligned, expected), label).toEqual(expected);
  }
});
