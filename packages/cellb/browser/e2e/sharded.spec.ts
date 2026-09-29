import { expect, type Page, test } from "@playwright/test";

const open = async (page: Page, wantOwned?: string, query = "") => {
  await page.goto(`/sharded/${query}`);
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || !!document.body.dataset.error,
  );
  expect((await page.evaluate(() => document.body.dataset.error)) ?? "").toBe("");
  if (wantOwned !== undefined)
    await page.waitForFunction((w) => document.body.dataset.owned === w, wantOwned, {
      timeout: 20_000,
    });
};
const get = (page: Page, path: string) =>
  page.evaluate((p) => fetch(p).then((r) => r.json()), path);

test("objects are spread over shard workers and DO → DO calls cross shards via the SW", async ({
  page,
}) => {
  await open(page, "0,1");
  const shards: Record<string, number> = {};
  for (let i = 0; i < 12; i++)
    shards[`o${i}`] = (await get(page, `/sharded/cells/counter/o${i}/shard`)).shard;
  expect(new Set(Object.values(shards))).toEqual(new Set([0, 1]));
  for (const [n, s] of Object.entries(shards))
    expect((await get(page, `/sharded/cells/counter/${n}/shard`)).shard).toBe(s); // stable
  const a = Object.keys(shards).find((n) => shards[n] === 0)!;
  const b = Object.keys(shards).find((n) => shards[n] === 1)!;
  expect(await get(page, `/sharded/cells/counter/${a}/bump/${b}`)).toMatchObject({
    me: 0,
    other: 1,
    n: 1,
  });
  expect(await get(page, "/sharded/__router")).toMatchObject({ attached: [0, 1] });
});

test("second tab uses the first tab's shards, then takes over (Web Locks) when it closes; OPFS state kept", async ({
  context,
}) => {
  const t1 = await context.newPage();
  await open(t1, "0,1");
  const name = `h${Date.now()}`;
  await get(t1, `/sharded/cells/counter/${name}/rpc/4`);

  const t2 = await context.newPage();
  await open(t2);
  // Tab 2 must be QUEUED on both shard locks (held by tab 1), not running workers of its own.
  await t2.waitForFunction(
    async () => {
      const q = await navigator.locks.query();
      const mine = (l: { name?: string }) => l.name?.startsWith("webrun-cells:shard:");
      return q.held!.filter(mine).length === 2 && q.pending!.filter(mine).length === 2;
    },
    null,
    { timeout: 10_000 },
  );
  await t2.waitForTimeout(1500); // long enough for a rogue worker to have opened a pool
  expect(await t2.evaluate(() => document.body.dataset.owned ?? "")).toBe("");
  expect((await get(t2, `/sharded/cells/counter/${name}`)).n).toBe(4); // served by tab 1's workers

  await t1.close(); // releases the locks and the OPFS pools
  await t2.waitForFunction(() => document.body.dataset.owned === "0,1", null, { timeout: 20_000 });
  expect((await get(t2, `/sharded/cells/counter/${name}/rpc/1`)).n).toBe(5);
});

test("a restarted ServiceWorker asks the pages to re-attach their shards", async ({
  page,
  context,
}) => {
  await open(page, "0,1");
  const name = `r${Date.now()}`;
  await get(page, `/sharded/cells/counter/${name}/rpc/2`);
  const boot1 = (await get(page, "/sharded/__router")).bootId;
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  expect((await get(page, `/sharded/cells/counter/${name}/rpc/1`)).n).toBe(3);
  const after = await get(page, "/sharded/__router");
  expect(after.bootId).not.toBe(boot1);
  expect(after.attached).toEqual([0, 1]);
});

test("an in-flight request fails fast when the owner tab closes, then the new owner serves", async ({
  context,
}) => {
  const t1 = await context.newPage();
  await open(t1, "0,1");
  const t2 = await context.newPage();
  await open(t2);
  const name = `d${Date.now()}`;
  await get(t2, `/sharded/cells/counter/${name}/rpc/2`);
  const slow = t2.evaluate(async (n) => {
    const t0 = performance.now();
    const r = await fetch(`/sharded/cells/counter/${n}/slow/15000`);
    return {
      status: r.status,
      ms: Math.round(performance.now() - t0),
      body: (await r.text()).slice(0, 200),
    };
  }, name);
  await t2.waitForTimeout(400);
  await t1.close();
  const r = await slow;
  console.log("in-flight after owner loss:", JSON.stringify(r));
  expect(r.status).toBeGreaterThanOrEqual(500);
  expect(r.body).toMatch(/was lost/);
  expect(r.ms - 400).toBeLessThan(300); // fails on owner death, not when the successor attaches
  await t2.waitForFunction(() => document.body.dataset.owned === "0,1", null, { timeout: 20_000 });
  expect((await get(t2, `/sharded/cells/counter/${name}/rpc/1`)).n).toBe(3);
});

test("measure: request latency warm vs. first request after a ServiceWorker restart", async ({
  page,
  context,
}) => {
  await open(page, "0,1");
  const name = `m${Date.now()}`;
  const time = () =>
    page.evaluate(async (n) => {
      const t0 = performance.now();
      await (await fetch(`/sharded/cells/counter/${n}/rpc/1`)).json();
      return performance.now() - t0;
    }, name);
  await time();
  const warm: number[] = [];
  for (let i = 0; i < 20; i++) warm.push(await time());
  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  const cold: number[] = [];
  for (let i = 0; i < 5; i++) {
    await cdp.send("ServiceWorker.stopAllWorkers");
    cold.push(await time());
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  console.log(
    `latency ms: warm median ${med(warm).toFixed(1)}, after SW restart median ${med(cold).toFixed(1)} (all: ${cold.map((x) => x.toFixed(0)).join(", ")})`,
  );
  expect(med(cold)).toBeLessThan(2_000);
});

test("with no tab left to take over, the owner-lock watch fails the in-flight request within ~100 ms", async ({
  context,
}) => {
  const t1 = await context.newPage();
  await open(t1, "0,1");
  const t2 = await context.newPage();
  await open(t2, undefined, "?passive");
  const name = `w${Date.now()}`;
  await get(t2, `/sharded/cells/counter/${name}/rpc/1`);
  const slow = t2.evaluate(async (n) => {
    const t0 = performance.now();
    const r = await fetch(`/sharded/cells/counter/${n}/slow/15000`);
    return {
      status: r.status,
      ms: Math.round(performance.now() - t0),
      body: (await r.text()).slice(0, 120),
    };
  }, name);
  await t2.waitForTimeout(400);
  await t1.close();
  const r = await slow;
  console.log("in-flight, no successor:", JSON.stringify(r));
  expect(r.status).toBeGreaterThanOrEqual(500);
  expect(r.body).toMatch(/was lost/);
  expect(r.ms - 400).toBeLessThan(300); // polling fallback is 5 s: only the lock watch can be this fast
});
