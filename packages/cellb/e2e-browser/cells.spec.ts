import { expect, test } from "@playwright/test";

// P04c — runs only in a real browser (Chromium): ServiceWorker + Dedicated Worker + OPFS.
const ready = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || !!document.body.dataset.error,
    null,
    { timeout: 30_000 },
  );
  const err = await page.evaluate(() => document.body.dataset.error);
  expect(err ?? "").toBe("");
};

test("plain fetch() from the page reaches the DO through SW → page → worker", async ({ page }) => {
  await ready(page);
  const name = `c${Date.now()}`;
  const ns = await page.evaluate(async (name) => {
    const out: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const r = await fetch(`/cells/counter/${name}/inc`, { method: "POST" });
        out.push((await r.json()).n);
      }),
    );
    return out.sort((a, b) => a - b);
  }, name);
  expect(ns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("state persists in OPFS across a page reload (worker restarted)", async ({ page }) => {
  await ready(page);
  const name = `p${Date.now()}`;
  await page.evaluate((name) => fetch(`/cells/counter/${name}/rpc/7`).then((r) => r.json()), name);
  await page.reload();
  await ready(page);
  const n = await page.evaluate(
    (name) =>
      fetch(`/cells/counter/${name}`)
        .then((r) => r.json())
        .then((j) => j.n),
    name,
  );
  expect(n).toBe(7);
});

test("RPC stubs from the page talk to the worker directly", async ({ page }) => {
  await ready(page);
  const n = await page.evaluate(async () => {
    const stub = (window as any).__cells.env.COUNTER.getByName(`r${Date.now()}`);
    await stub.increment(2);
    return stub.increment(3);
  });
  expect(n).toBe(5);
});

test("an iframe navigates to a DO-served URL (true HTTP ingress via the SW)", async ({ page }) => {
  await ready(page);
  const name = `f${Date.now()}`;
  await page.evaluate((name) => fetch(`/cells/counter/${name}/rpc/3`), name);
  const frame = await page.evaluate((name) => {
    const f = document.createElement("iframe");
    f.src = `/cells/counter/${name}`;
    document.body.append(f);
    return new Promise<string>((r) => (f.onload = () => r(f.contentDocument!.body.innerText)));
  }, name);
  expect(JSON.parse(frame).n).toBe(3);
});

test("a DO streams a response to the page through SW → page → worker", async ({ page }) => {
  await ready(page);
  const chunks = await page.evaluate(async () => {
    const res = await fetch(`/cells/counter/s${Date.now()}/ticks`);
    const reader = res.body!.getReader();
    const out: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(new TextDecoder().decode(value));
    }
    return out;
  });
  expect(chunks.join("")).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");
});
