import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";
import { idFromName, namespaceKey } from "../src/core/id.ts";
import { shardOf } from "../src/core/shard.ts";
import { bundleWorkerForBrowser } from "../src/node.ts";

// One project shared by the tabs of an origin (joinProjectShards / installProjectRouter): the
// shards are split evenly over the open tabs and move when tabs come and go; their cells (OPFS
// pools of the origin) move with them, so every counter keeps counting.
const owned = (page: Page) =>
  page.evaluate(() => (document.body.dataset.owned ?? "").split(",").filter(Boolean).map(Number));

async function openTab(page: Page, job: object) {
  await page.goto("/tabs/");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.evaluate((j) => (window as any).__join(j), job);
}

test("tabs share a project: shards split over them and follow them", async ({ context }) => {
  test.setTimeout(120_000);
  const project = await bundleProjectForBrowser("counter");
  const job = {
    name: `tabs-${Date.now().toString(36)}`,
    shards: 4,
    config: project.config,
    code: project.code,
  };
  const names = Array.from({ length: 13 }, (_, i) => `n${i}`);
  const counts = new Map<string, number>();
  /** One request per counter through `page`: each must count one more than before. */
  const round = async (page: Page) => {
    const answers = await Promise.all(
      names.map((n) => page.evaluate((p) => (window as any).__fetch(p), `/?name=${n}`)),
    );
    for (const [i, a] of answers.entries()) {
      expect(a.status, a.body).toBe(200);
      const n = names[i];
      counts.set(n, (counts.get(n) ?? 0) + 1);
      expect(JSON.parse(a.body).n, n).toBe(counts.get(n));
    }
  };

  const a = await context.newPage();
  await openTab(a, job);
  await expect.poll(() => owned(a)).toEqual([0, 1, 2, 3]);
  await round(a);

  // A second tab: the shards split evenly, the oldest tab keeping shards 0 and 2.
  const b = await context.newPage();
  await openTab(b, job);
  await expect.poll(() => owned(b)).toEqual([1, 3]);
  await expect.poll(() => owned(a)).toEqual([0, 2]);
  await round(a); // cells of shards 1 and 3 now run in tab b, reached through the router
  await round(b);

  // The first tab closes: its shards move to the second, which runs all four.
  await a.close();
  await expect.poll(() => owned(b)).toEqual([0, 1, 2, 3]);
  await round(b);
});

// A planned hand-over drains the shard: a request in flight in it when another tab takes the
// shard finishes there, instead of failing as when a tab dies.
test("a request in flight in a shard handed to another tab finishes", async ({ context }) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), "tabs-slow-"));
  writeFileSync(
    join(dir, "index.js"),
    `export class Slow {
      async fetch(req) {
        const ms = Number(new URL(req.url).searchParams.get("ms") ?? 0);
        await new Promise((r) => setTimeout(r, ms));
        return new Response("done");
      }
    }
    export default {
      fetch: (req, env) =>
        env.SLOW.getByName(new URL(req.url).searchParams.get("name")).fetch(req),
    };`,
  );
  const config = {
    name: "slow",
    main: "index.js",
    durable_objects: { bindings: [{ name: "SLOW", class_name: "Slow" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Slow"] }],
  };
  const job = {
    name: `drain-${Date.now().toString(36)}`,
    shards: 2,
    config,
    code: await bundleWorkerForBrowser(join(dir, "index.js")),
  };
  // A name whose object is in shard 1: the shard the second tab takes.
  const ns = namespaceKey("slow", "Slow");
  const name = Array.from({ length: 50 }, (_, i) => `s${i}`).find(
    (n) => shardOf(idFromName(ns, n).toString(), 2) === 1,
  )!;

  const a = await context.newPage();
  await openTab(a, job);
  await expect.poll(() => owned(a)).toEqual([0, 1]);
  const slow = a.evaluate((p) => (window as any).__fetch(p), `/?name=${name}&ms=1500`);
  await a.waitForTimeout(200); // in flight in tab a's shard 1
  const b = await context.newPage();
  await openTab(b, job);
  expect(await slow).toEqual({ status: 200, body: "done" });
  await expect.poll(() => owned(b)).toEqual([1]);
  expect(await a.evaluate((p) => (window as any).__fetch(p), `/?name=${name}&ms=0`)).toEqual({
    status: 200,
    body: "done",
  });
});
