import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { idFromName, namespaceKey } from "../src/core/id.ts";
import { shardOf } from "../src/core/shard.ts";
import { bundleWorkerForBrowser } from "../src/node.ts";
import { parseJsonc } from "../src/project/jsonc.ts";

// Service bindings between fragments in a browser (#192): delta binds gamma's `Api` entrypoint and
// default export. A call runs where gamma's fragment DO is: in the caller's shard worker when it
// owns it, else in the owner's, reached through the ServiceWorker's router (MessagePorts).

const FIXTURES = join(import.meta.dirname, "../test/fixtures/fragments");
const SHARDS = 2;
const KEY = namespaceKey("fragment", "Fragment");
const shard = (id: string) => shardOf(idFromName(KEY, id).toString(), SHARDS);

async function fragment(name: "gamma" | "delta", gamma?: string) {
  const dir = join(FIXTURES, name);
  const config = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as {
    services?: { service: string }[];
  };
  // Bound to this run's gamma.
  for (const s of config.services ?? []) s.service = gamma as string;
  return { config, code: await bundleWorkerForBrowser(join(dir, "worker.js")) };
}

/** A gamma and a delta id of this run whose fragment DOs are on the same shard, or not. */
function ids(sameShard: boolean) {
  const stamp = Date.now().toString(36);
  const delta = `delta-${stamp}`;
  for (let i = 0; ; i++) {
    const gamma = `gamma-${stamp}-${i}`;
    if ((shard(gamma) === shard(delta)) === sameShard) return { gamma, delta };
  }
}

async function openPool(page: Page) {
  await page.goto("/tabs/index.html");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.evaluate((s) => (window as any).__joinFragments({ shards: s }), SHARDS);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.fragmentsOwned ?? ""))
    .toBe("0,1");
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

for (const sameShard of [true, false])
  test(`fetch and JS RPC through a service binding, the target's fragment DO ${
    sameShard ? "on the caller's shard" : "on another shard"
  }`, async ({ page }) => {
    test.setTimeout(120_000);
    const { gamma, delta } = ids(sameShard);
    await openPool(page);
    await add(page, gamma, await fragment("gamma"));
    expect(await add(page, delta, await fragment("delta", gamma))).toEqual({ unsupported: [] });

    expect(await get(page, `${delta}/hello`)).toEqual({
      status: 200,
      body: JSON.stringify('hello delta from gamma, props {"who":"delta"}'),
    });
    expect(await get(page, `${delta}/count`)).toEqual({ status: 200, body: "1" });
    expect(await get(page, `${delta}/count`)).toEqual({ status: 200, body: "2" });
    expect(await get(page, `${delta}/fetch`)).toEqual({
      status: 201,
      body: "gamma default GET /p?q=1 ",
    });
    expect(await get(page, `${delta}/upper`)).toEqual({ status: 200, body: "ONE TWO" });
    const failed = await get(page, `${delta}/fail`);
    expect(JSON.parse(failed.body)).toEqual({
      error: { name: "RangeError", message: "gamma refused" },
    });
    const refused = JSON.parse((await get(page, `${delta}/function`)).body);
    expect(refused.error.name).toBe("DataCloneError");
    expect(refused.error.message).toContain(
      `services[API] → "${gamma}" Api.echo(): the arguments[0] is a function`,
    );

    // gamma removed: the binding fails at once with the defined error.
    await page.evaluate((id) => (window as any).__removeFragment(id), gamma);
    const gone = JSON.parse((await get(page, `${delta}/hello`)).body);
    expect(gone.error.name).toBe("ServiceUnavailableError");
    expect(gone.error.message).toContain(`services[API] → "${gamma}" Api.hello()`);
    // Back again: the same binding reaches it, its data kept.
    await add(page, gamma, await fragment("gamma"));
    expect(await get(page, `${delta}/count`)).toEqual({ status: 200, body: "3" });
  });
