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

/** Stops every ServiceWorker of the browser, as Chromium does with an idle one. */
async function stopServiceWorkers(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach();
}

// A ServiceWorker that the browser stopped loses its routers and their ports: the first request
// to the restarted one asks every tab to link its shards again.
test("a restarted ServiceWorker gets the shards of every tab back", async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "stops the ServiceWorker through CDP (Chromium only)");
  test.setTimeout(120_000);
  const project = await bundleProjectForBrowser("counter");
  const job = {
    name: `restart-${Date.now().toString(36)}`,
    shards: 2,
    config: project.config,
    code: project.code,
  };
  const names = Array.from({ length: 6 }, (_, i) => `n${i}`);
  const a = await context.newPage();
  await openTab(a, job);
  await expect.poll(() => owned(a)).toEqual([0, 1]);
  const b = await context.newPage();
  await openTab(b, job);
  await expect.poll(() => owned(b)).toEqual([1]);
  await expect.poll(() => owned(a)).toEqual([0]);
  const count = async (page: Page, n: string) => {
    const r = await page.evaluate((p) => (window as any).__fetch(p), `/?name=${n}`);
    expect(r.status, r.body).toBe(200);
    return JSON.parse(r.body).n as number;
  };
  for (const n of names) expect(await count(a, n)).toBe(1);
  for (let round = 2; round <= 3; round++) {
    await stopServiceWorkers(a);
    // Every counter, whichever tab runs its shard, keeps counting.
    for (const n of names) expect(await count(round === 2 ? a : b, n)).toBe(round);
  }
});

// A call that starts inside a shard (an alarm here; a timer, a WebSocket message) does not wake
// the ServiceWorker the way a fetch does. A call from one shard to another must still go through
// once the stopped ServiceWorker's links are gone.
/** A project whose object in shard 0 calls one in shard 1 from an alarm (`/arm`, `/result`). */
async function wakeProject() {
  const dir = mkdtempSync(join(tmpdir(), "tabs-wake-"));
  writeFileSync(
    join(dir, "index.js"),
    `import { DurableObject } from "cloudflare:workers";
    export class Box extends DurableObject {
      async arm(to, ms, slow) {
        await this.ctx.storage.put("to", to);
        await this.ctx.storage.put("slow", slow);
        await this.ctx.storage.setAlarm(Date.now() + ms);
        return "armed";
      }
      async alarm() {
        const to = await this.ctx.storage.get("to");
        try {
          const slow = await this.ctx.storage.get("slow");
          await this.ctx.storage.put("result", "bumped " + (await this.env.BOX.getByName(to).bump(slow)));
        } catch (e) {
          await this.ctx.storage.put("result", "failed: " + e.message);
        }
      }
      async bump(slow) {
        await new Promise((r) => setTimeout(r, slow ?? 0));
        const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
        await this.ctx.storage.put("n", n);
        return n;
      }
      async result() { return (await this.ctx.storage.get("result")) ?? "pending"; }
    }
    export default {
      async fetch(req, env) {
        const u = new URL(req.url);
        const box = env.BOX.getByName(u.searchParams.get("name"));
        if (u.pathname.endsWith("/arm")) // the URL keeps the router's prefix
          return new Response(
            await box.arm(
              u.searchParams.get("to"),
              Number(u.searchParams.get("ms")),
              Number(u.searchParams.get("slow") ?? 0),
            ),
          );
        return new Response(await box.result());
      },
    };`,
  );
  const config = {
    name: "wake",
    main: "index.js",
    durable_objects: { bindings: [{ name: "BOX", class_name: "Box" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Box"] }],
  };
  const job = {
    name: `wake-${Date.now().toString(36)}`,
    shards: 2,
    config,
    code: await bundleWorkerForBrowser(join(dir, "index.js")),
  };
  const ns = namespaceKey("wake", "Box");
  const inShard = (s: number) =>
    Array.from({ length: 50 }, (_, i) => `b${i}`).find(
      (n) => shardOf(idFromName(ns, n).toString(), 2) === s,
    )!;
  return { job, from: inShard(0), to: inShard(1) };
}

test("a shard's call into another shard wakes a stopped ServiceWorker", async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "stops the ServiceWorker through CDP (Chromium only)");
  test.setTimeout(120_000);
  const { job, from, to } = await wakeProject();
  const a = await context.newPage();
  await openTab(a, job);
  await expect.poll(() => owned(a)).toEqual([0, 1]);
  const call = (p: string) => a.evaluate((x) => (window as any).__fetch(x), p);
  expect(await call(`/arm?name=${from}&to=${to}&ms=1500`)).toEqual({ status: 200, body: "armed" });
  await stopServiceWorkers(a);
  // No request reaches the ServiceWorker until the alarm's call is due to have finished.
  await a.waitForTimeout(4_000);
  expect(await call(`/result?name=${from}`)).toEqual({ status: 200, body: "bumped 1" });
});

// The ServiceWorker is stopped while a call from one shard into another is in flight: the answer
// is lost with its ports, so the call fails (it may or may not have been applied), as when the
// owner of a shard dies, instead of hanging.
test("a call in flight when the ServiceWorker stops fails instead of hanging", async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "stops the ServiceWorker through CDP (Chromium only)");
  test.setTimeout(120_000);
  const { job, from, to } = await wakeProject();
  const a = await context.newPage();
  await openTab(a, job);
  await expect.poll(() => owned(a)).toEqual([0, 1]);
  const call = (p: string) => a.evaluate((x) => (window as any).__fetch(x), p);
  // The alarm fires after 500 ms and calls an object that answers 2 s later.
  expect(await call(`/arm?name=${from}&to=${to}&ms=500&slow=2000`)).toEqual({
    status: 200,
    body: "armed",
  });
  await a.waitForTimeout(1_500);
  await stopServiceWorkers(a);
  await a.waitForTimeout(2_000);
  const r = await call(`/result?name=${from}`);
  expect(r.status).toBe(200);
  expect(r.body).toMatch(/^failed: The router was lost while this call was in flight/);
});
