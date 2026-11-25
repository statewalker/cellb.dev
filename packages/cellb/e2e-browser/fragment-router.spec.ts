import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../src/node.ts";
import { parseJsonc } from "../src/project/jsonc.ts";

// The fragment host's ServiceWorker router (statewalker-root#259): it answers 404 for a fragment no
// tab knows and 503 for a disabled one itself, without waking a shard, and serves
// `<basePath>peers/<self>/fragments/<id>/…` as `<basePath>fragments/<id>/…`.

const FIXTURES = join(import.meta.dirname, "../test/fixtures/fragments");

async function alpha() {
  const dir = join(FIXTURES, "alpha");
  return {
    config: parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as object,
    code: await bundleWorkerForBrowser(join(dir, "worker.js")),
  };
}

async function openPool(page: Page, peerId?: string) {
  await page.goto("/tabs/index.html");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.evaluate((job) => (window as any).__joinFragments(job), { shards: 2, peerId });
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.fragmentsOwned ?? ""))
    .toBe("0,1");
}

const call = (page: Page, name: string, id: string) =>
  page.evaluate(([n, i]) => (window as any)[n](i), [name, id] as const);

const get = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const res = await fetch(`/tabs/app/${p}`);
    return { status: res.status, body: await res.text() };
  }, path);

test("unknown fragments answer 404 and disabled ones 503 from the router, without waking their DO", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  await openPool(page);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...(await alpha()) });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });

  // Unknown: the router's own answer (a shard's would not start with "cellb:").
  expect(await get(page, `fragments/nope-${id}/x`)).toEqual({
    status: 404,
    body: `cellb: no fragment "nope-${id}" on this host`,
  });

  await call(page, "__disableFragment", id);
  for (let i = 0; i < 3; i++)
    expect(await get(page, `fragments/${id}/x`)).toEqual({
      status: 503,
      body: `cellb: fragment "${id}" is disabled`,
    });
  expect(await page.evaluate(() => (window as any).__fragmentIds())).toEqual([id]);

  // Enabled again: its fragment DO counts on from where it was, so none of the 503s reached it.
  await call(page, "__enableFragment", id);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });

  // Removed: unknown again.
  await call(page, "__removeFragment", id);
  expect((await get(page, `fragments/${id}/x`)).status).toBe(404);
});

test("/peers/<self>/fragments/<id>/… answers as /fragments/<id>/…; other peers are not routed here", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  await openPool(page, "peer-self");
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...(await alpha()) });
  const direct = JSON.parse((await get(page, `fragments/${id}/notes/1`)).body);
  expect(direct).toMatchObject({ label: "alpha", n: 1, path: "/notes/1" });
  const viaPeer = JSON.parse((await get(page, `peers/peer-self/fragments/${id}/notes/1`)).body);
  // The same fragment DO, the same path.
  expect(viaPeer).toMatchObject({ label: "alpha", n: 2, path: "/notes/1", id: direct.id });
  expect((await get(page, `peers/peer-self/fragments/nope-${id}/x`)).status).toBe(404);
  // Another peer's path is the gateway's, not this router's.
  const other = await get(page, `peers/peer-other/fragments/${id}/x`);
  expect(other.body).not.toContain('"label"');
});
