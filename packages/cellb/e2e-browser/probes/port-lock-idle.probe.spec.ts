import { test } from "@playwright/test";

const go = async (p: import("@playwright/test").Page) => {
  await p.goto("/probe/");
  await p.evaluate(() => (window as any).__swReady);
};

test("A: MessagePort close event", async ({ page }) => {
  await go(page);
  console.log("A", JSON.stringify(await page.evaluate(() => (window as any).__portClose())));
});

test("B: SW detects a dead owner through a pending Web Lock request", async ({ context }) => {
  const owner = await context.newPage();
  await go(owner);
  const other = await context.newPage();
  await go(other);
  await owner.evaluate(() => (window as any).__holdLock("owner:shard0:abc"));
  console.log(
    "B watch",
    await other.evaluate(() => (window as any).__sw({ type: "watch", name: "owner:shard0:abc" })),
  );
  await other.waitForTimeout(300);
  console.log(
    "B before close",
    await other.evaluate(() => (window as any).__sw({ type: "lost", name: "owner:shard0:abc" })),
  );
  const closedAt = Date.now();
  await owner.close();
  await other.waitForTimeout(500);
  const lostAt = await other.evaluate(() =>
    (window as any).__sw({ type: "lost", name: "owner:shard0:abc" }),
  );
  console.log("B detection latency ms:", lostAt ? (lostAt as number) - closedAt : "not detected");
});

test("C: SW idle termination with and without a page heartbeat", async ({ context }) => {
  test.setTimeout(200_000);
  const p = await context.newPage();
  await go(p);
  const b0 = (await p.evaluate(() => (window as any).__sw({ type: "boot" }))) as any;
  await p.waitForTimeout(45_000);
  const b1 = (await p.evaluate(() => (window as any).__sw({ type: "boot" }))) as any;
  console.log(
    "C no heartbeat, after 45 s idle: same SW?",
    b0.bootId === b1.bootId,
    JSON.stringify(b1),
  );
  await p.evaluate(() => (window as any).__heartbeat(10_000));
  await p.waitForTimeout(60_000);
  const b2 = (await p.evaluate(() => (window as any).__sw({ type: "boot" }))) as any;
  console.log(
    "C heartbeat 10 s, after 60 s: same SW?",
    b1.bootId === b2.bootId,
    JSON.stringify(b2),
  );
});
