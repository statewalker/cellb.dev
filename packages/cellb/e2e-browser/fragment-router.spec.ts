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

// The merge gate's pass 1 on #248 (H2–H4).
test("a remove during an add wins: the fragment is not left enabled", async ({ page }) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  await openPool(page);
  const f = await alpha();
  const outcome = await page.evaluate(
    async ([job, i]) => {
      const w = window as any;
      const adding = w.__addFragment(job).then(
        () => "added",
        (e: Error) => `refused: ${e.message}`,
      );
      await w.__removeFragment(i);
      return { add: await adding, ids: w.__fragmentIds() };
    },
    [{ id, ...f }, id] as const,
  );
  expect(outcome.ids).toEqual([]);
  expect((await get(page, `fragments/${id}/x`)).status).toBe(404);
});

test("after a ServiceWorker restart: every tab's table counts, and /peers/<self>/ still answers", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "stops the ServiceWorker through CDP (Chromium only)");
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  await openPool(page, "peer-self");
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...(await alpha()) });
  expect((await get(page, `fragments/${id}/x`)).status).toBe(200);

  // A second tab whose table is empty (it knows no fragment), answering at once.
  const other = await context.newPage();
  await other.goto("/tabs/index.html");
  await other.waitForFunction(() => document.body.dataset.ready === "true");
  await other.evaluate(() => {
    const table = { type: "cellb:fragment-table", fragments: {} };
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "cellb:need-fragment-table")
        navigator.serviceWorker.controller?.postMessage(table);
    });
    navigator.serviceWorker.controller?.postMessage(table);
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  // The own-peer path first: nothing has refilled the tables yet.
  await cdp.send("ServiceWorker.stopAllWorkers");
  const viaPeer = await get(page, `peers/peer-self/fragments/${id}/x`);
  expect(viaPeer.status, viaPeer.body).toBe(200);
  expect(JSON.parse(viaPeer.body)).toMatchObject({ label: "alpha" });
  // Then a plain request, each restart again: the empty table must not hide the first tab's.
  for (let i = 0; i < 3; i++) {
    await cdp.send("ServiceWorker.stopAllWorkers");
    const res = await get(page, `fragments/${id}/x`);
    expect(res.status, res.body).toBe(200);
  }
});

// statewalker-root#261: "remove with data" deletes the fragment's OPFS pools in the shards; a
// plain removal keeps them (fragments.spec.ts).
test("a fragment removed with its data starts from nothing when added again", async ({ page }) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  await openPool(page);
  const f = await alpha();
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });
  const pools = () =>
    page.evaluate(async (i) => {
      const names: string[] = [];
      for await (const name of (
        (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> }
      ).keys())
        if (name.includes(i)) names.push(name);
      return names.sort();
    }, id);
  expect((await pools()).length).toBeGreaterThan(0);
  await page.evaluate(([i]) => (window as any).__removeFragment(i, true), [id] as const);
  expect(await pools()).toEqual([]);
  expect((await get(page, `fragments/${id}/x`)).status).toBe(404);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });
  // Disabled, then removed with its data: gone as well.
  await page.evaluate((i) => (window as any).__disableFragment(i), id);
  await page.evaluate(([i]) => (window as any).__removeFragment(i, true), [id] as const);
  expect(await pools()).toEqual([]);
});

// statewalker/cellb.dev#252: the tabs split the shards between them; "remove with data" from one
// tab reaches the shards the others run, and a shard that starts later does not bring it back.
async function joinSecond(page: Page) {
  await page.goto("/tabs/index.html");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  await page.evaluate((job) => (window as any).__joinFragments(job), { shards: 2 });
}

const owned = (page: Page) => page.evaluate(() => document.body.dataset.fragmentsOwned ?? "");

const poolsOf = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const names: string[] = [];
    for await (const name of (
      (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> }
    ).keys())
      if (name.includes(i)) names.push(name);
    return names.sort();
  }, id);

test("removed with its data from one tab, a fragment is gone from the shards every tab runs", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  const f = await alpha();
  await openPool(page);
  const other = await context.newPage();
  await joinSecond(other);
  // One shard each.
  await expect
    .poll(() => Promise.all([owned(page), owned(other)]))
    .toEqual(
      expect.arrayContaining([expect.stringMatching(/^[01]$/), expect.stringMatching(/^[01]$/)]),
    );
  expect(new Set([await owned(page), await owned(other)]).size).toBe(2);
  // Both tabs add it (as every tab adds the enabled fragments): both shards hold its pool.
  for (const p of [page, other])
    await p.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });
  const before = await poolsOf(page, id);
  expect(before.filter((n) => n.includes("-shard-")).length).toBe(2);

  await page.evaluate(([i]) => (window as any).__removeFragment(i, true), [id] as const);
  expect(await poolsOf(page, id)).toEqual([]);
  // The other tab removed it too: nobody serves it.
  await expect.poll(() => other.evaluate(() => (window as any).__fragmentIds())).toEqual([]);
  expect((await get(page, `fragments/${id}/x`)).status).toBe(404);

  for (const p of [page, other])
    await p.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });
});

test("a shard that starts after a removal with data deletes the data before it serves", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  const f = await alpha();
  await openPool(page);
  const other = await context.newPage();
  await joinSecond(other);
  await expect.poll(async () => new Set([await owned(page), await owned(other)]).size).toBe(2);
  for (const p of [page, other])
    await p.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });

  // The other tab goes: its shard is nobody's until this tab takes it, after the removal began.
  await other.close();
  await page.evaluate(([i]) => (window as any).__removeFragment(i, true), [id] as const);
  await expect.poll(() => owned(page)).toBe("0,1");
  expect(await poolsOf(page, id)).toEqual([]);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });
});

/** A removal marker left as a removing tab leaves it, for `shards` shards (#252). */
const leaveMarkers = (page: Page, id: string, shards: number) =>
  page.evaluate(
    async ([i, n]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(".cellb-fragment-removals", { create: true });
      for (let s = 0; s < (n as number); s++) {
        const file = await dir.getFileHandle(`${i}@${s}`, { create: true });
        const w = await (file as any).createWritable();
        await w.write(String(Date.now() * 1000));
        await w.close();
      }
    },
    [id, shards] as const,
  );

const markersLeft = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = (await root.getDirectoryHandle(".cellb-fragment-removals")) as any;
      const names: string[] = [];
      for await (const name of dir.keys()) if (name.startsWith(`${i}@`)) names.push(name);
      return names;
    } catch {
      return [];
    }
  }, id);

test("shards that start with a removal pending delete the data before they serve", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  const f = await alpha();
  await openPool(page);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });
  // The pool stops; a removal is left for its shards (a tab removed it meanwhile); it starts.
  await page.evaluate(() => (window as any).__leaveFragments());
  await leaveMarkers(page, id, 2);
  await page.evaluate((job) => (window as any).__joinFragments(job), { shards: 2 });
  await expect.poll(() => owned(page)).toBe("0,1");
  await expect.poll(() => markersLeft(page, id)).toEqual([]);
  expect((await poolsOf(page, id)).filter((n) => n.includes("-shard-"))).toEqual([]);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });
});

test("a removal pending for running shards is applied before the fragment loads again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  const f = await alpha();
  await openPool(page);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });
  // Removed here keeping its data; meanwhile another tab's removal with data left its markers.
  await page.evaluate((i) => (window as any).__removeFragment(i), id);
  await leaveMarkers(page, id, 2);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 1 });
  expect(await markersLeft(page, id)).toEqual([]);
});

test("a removal older than a tab's copy of the fragment leaves that copy", async ({ page }) => {
  test.setTimeout(120_000);
  const id = `alpha-${Date.now().toString(36)}`;
  const f = await alpha();
  await openPool(page);
  await page.evaluate((job) => (window as any).__addFragment(job), { id, ...f });
  await get(page, `fragments/${id}/x`);
  // Another tab's removal from before this copy was added, its message late: ignored.
  await page.evaluate(
    (i) =>
      new BroadcastChannel("cellb:fragment-removals").postMessage({
        removed: i,
        epoch: (Date.now() - 60_000) * 1000,
      }),
    id,
  );
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__fragmentIds())).toEqual([id]);
  expect(JSON.parse((await get(page, `fragments/${id}/x`)).body)).toMatchObject({ n: 2 });
  // A removal from after it: the fragment goes, with its data.
  await page.evaluate(
    (i) =>
      new BroadcastChannel("cellb:fragment-removals").postMessage({
        removed: i,
        epoch: (Date.now() + 1000) * 1000,
      }),
    id,
  );
  await expect.poll(() => page.evaluate(() => (window as any).__fragmentIds())).toEqual([]);
  await expect
    .poll(async () => (await poolsOf(page, id)).filter((n) => n.includes("-shard-")))
    .toEqual([]);
});

// statewalker/cellb.dev#251: "remove with data" deletes the fragment's isolates' pools too, in
// either name, and never another fragment's, even one whose id is chosen to collide.
test("removed with its data, a fragment's isolates' pools go, and only its own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const a = `iso${Date.now().toString(36)}`;
  const b = `${a}-shard-0-iso-x`; // its names begin as a's former isolate pools did
  const mine = [
    `.fragments-${a}-shard-0-ISO-loader1`,
    `.fragments-${a}-shard-1-ISO-loader2`,
    `.fragments-${a}-shard-0-iso-former`,
  ];
  const others = [
    `.fragments-${b}-shard-0`,
    `.fragments-${b}-shard-0-ISO-z`,
    `.fragments-${b}-shard-0-iso-z`,
  ];
  await openPool(page);
  await page.evaluate(
    async (names) => {
      const root = await navigator.storage.getDirectory();
      for (const n of names) await root.getDirectoryHandle(n, { create: true });
    },
    [...mine, ...others],
  );
  await page.evaluate(([i]) => (window as any).__removeFragment(i, true), [a] as const);
  const left = await page.evaluate(
    async (names) => {
      const root = (await navigator.storage.getDirectory()) as any;
      const found: string[] = [];
      for await (const n of root.keys()) if (names.includes(n)) found.push(n);
      return found.sort();
    },
    [...mine, ...others],
  );
  expect(left).toEqual([...others].sort());
});
