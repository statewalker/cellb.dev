import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { idFromName, namespaceKey } from "../src/core/id.ts";
import { bundleWorkerForBrowser } from "../src/node.ts";
import { parseJsonc } from "../src/project/jsonc.ts";

// The fragment host in a browser (#191): one pool of shard workers shared by the tabs, each
// worker holding every fragment, and the ServiceWorker's router sending
// /tabs/app/fragments/<id>/… to it. Two fragments with the same Worker name, class and binding
// names are kept apart; each request reaches its fragment's fragment DO at idFromName(<id>).

const FIXTURES = join(import.meta.dirname, "../test/fixtures/fragments");

async function fragment(name: "alpha" | "beta") {
  const dir = join(FIXTURES, name);
  return {
    config: parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as object,
    code: await bundleWorkerForBrowser(join(dir, "worker.js")),
  };
}

async function openPool(page: Page, shards: number) {
  await page.goto("/tabs/index.html");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.evaluate((s) => (window as any).__joinFragments({ shards: s }), shards);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.fragmentsOwned ?? ""))
    .toBe(Array.from({ length: shards }, (_, i) => i).join(","));
}

const add = (page: Page, id: string, f: { config: object; code: string }) =>
  page.evaluate((job) => (window as any).__addFragment(job), { id, ...f }) as Promise<{
    unsupported: string[];
  }>;

const get = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const res = await fetch(`/tabs/app/fragments/${p}`);
    return { status: res.status, body: await res.text() };
  }, path);

const json = async (page: Page, path: string) => {
  const res = await get(page, path);
  expect(res.status, res.body).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
};

test("two fragments with the same names, side by side in one shard pool, each its own data", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const [a, b] = [`alpha-${stamp}`, `beta-${stamp}`];
  await openPool(page, 2);
  expect(await add(page, a, await fragment("alpha"))).toEqual({ unsupported: [] });
  // One fragment's unsupported configuration is its own.
  expect((await add(page, b, await fragment("beta"))).unsupported).toEqual([
    "compatibility_flags: no_such_flag_for_test",
  ]);

  const first = await json(page, `${a}/notes/1?q=2`);
  expect(first).toMatchObject({ label: "alpha", n: 1, path: "/notes/1" });
  // Its fragment DO: the object at idFromName(<id>) of its FRAGMENT binding.
  const ns = namespaceKey("fragment", "Fragment");
  expect(first.id).toBe(idFromName(ns, a).toString());
  expect(await json(page, `${a}/x`)).toMatchObject({ n: 2 });
  expect(await json(page, `${b}/x`)).toMatchObject({ label: "beta", n: 1 });
  await json(page, `${a}/kv?put=from-alpha`);
  expect(await json(page, `${b}/kv`)).toEqual({ kv: null });
  expect(await json(page, `${a}/kv`)).toEqual({ kv: "from-alpha" });
});

test("fragments are added and removed while the pool runs; the others keep serving; data is kept", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const [a, b] = [`alpha-${stamp}`, `beta-${stamp}`];
  await openPool(page, 2);
  await add(page, a, await fragment("alpha"));
  await add(page, b, await fragment("beta"));
  await json(page, `${b}/x`);
  await page.evaluate((id) => (window as any).__removeFragment(id), b);
  expect(await page.evaluate(() => (window as any).__fragmentIds())).toEqual([a]);
  expect((await get(page, `${b}/x`)).status).toBe(404);
  expect(await json(page, `${a}/x`)).toMatchObject({ n: 1 });
  // Added again, it finds its data (its OPFS pools are kept).
  await add(page, b, await fragment("beta"));
  expect(await json(page, `${b}/x`)).toMatchObject({ n: 2 });
  expect((await get(page, `nope-${stamp}/x`)).status).toBe(404);
});

test("fragments added at once each keep their own module env (cloudflare:workers)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const [a, b] = [`alpha-${stamp}`, `beta-${stamp}`];
  await openPool(page, 1);
  const [fa, fb] = [await fragment("alpha"), await fragment("beta")];
  await page.evaluate(
    (jobs) => Promise.all(jobs.map((j) => (window as any).__addFragment(j))),
    [
      { id: a, ...fa },
      { id: b, ...fb },
    ],
  );
  expect(await json(page, `${a}/modkv?put=written-by-alpha`)).toEqual({
    own: "written-by-alpha",
    label: "alpha",
  });
  expect(await json(page, `${b}/modkv`)).toEqual({ own: null, label: "beta" });
});

test("a fragment DO takes sockets and the page's cookies, and its Set-Cookie reaches the page", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the router's cookies need the Cookie Store API");
  test.setTimeout(120_000);
  const a = `alpha-${Date.now().toString(36)}`;
  await openPool(page, 2);
  await add(page, a, await fragment("alpha"));
  expect(
    await page.evaluate((p) => (window as any).__socket("/ws", "hi", p), `fragments/${a}`),
  ).toBe("alpha: hi");
  expect((await get(page, `${a}/set-cookie`)).body).toBe("set");
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain("fragcookie=1");
  expect((await get(page, `${a}/cookie`)).body).toContain("fragcookie=1");
});

test("a fragment that cannot load is refused or reported, and the others keep serving", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const a = `alpha-${stamp}`;
  await openPool(page, 2);
  const alpha = await fragment("alpha");
  // No fragment DO: two Durable Object bindings, neither named FRAGMENT.
  const bad = {
    ...alpha,
    config: {
      ...(alpha.config as Record<string, unknown>),
      durable_objects: {
        bindings: [
          { name: "ONE", class_name: "Fragment" },
          { name: "TWO", class_name: "Fragment" },
        ],
      },
    },
  };
  await expect(add(page, `bad-${stamp}`, bad)).rejects.toThrow(/fragment DO/);
  await add(page, a, alpha);
  expect(await json(page, `${a}/x`)).toMatchObject({ label: "alpha", n: 1 });
});
