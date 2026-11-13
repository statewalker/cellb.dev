import { expect, type Page, test } from "@playwright/test";

// The package cache's clean-up (the host page's "Package cache" panel, the package store's
// /admin/* routes): the small app is built through the store, then its unused packages are
// pruned (not while a build holds a lease, nor with an unreadable lock), its locks and version
// index forgotten and the store cleared; a rebuild after the clear downloads every
// package again and still serves the site.

type Stats = {
  files: number;
  packages: number;
  locks: number;
  size: number;
  builds: number;
  removed?: number;
};
const STORE = "/__cellb/projects/pkgstore";
const cache = (host: Page, op: "stats" | "prune" | "forget" | "clear") =>
  host.evaluate(
    (op) =>
      (window as unknown as { __packageCache(op: string): Promise<Stats> }).__packageCache(op),
    op,
  );

async function built(host: Page) {
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 240_000 },
  );
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  return (await host.locator("#log").textContent()) ?? "";
}

test("the package cache is pruned and cleared from the host page", async ({ context }) => {
  test.setTimeout(600_000);
  const host = await context.newPage();
  host.on(
    "console",
    (m) => m.type() === "error" && console.log(`[host] ${m.text().slice(0, 300)}`),
  );
  await host.goto("/__cellb/");
  await built(host);

  await expect(host.locator("#cache")).toBeVisible();
  await expect(host.locator("#cache-stats")).toContainText(/\d+ packages, 1 lock/);
  await expect(host.locator("#cache button").first()).toBeEnabled();
  const before = await cache(host, "stats");
  expect(before.packages).toBeGreaterThan(10);
  expect(before.locks).toBe(1);

  // A pack no lock names is removed by prune; the ones the lock names stay.
  const stray = await host.evaluate(async () => {
    const r = await fetch("/__cellb/projects/pkgstore/files/pkgs/not-used@0.0.0.pack", {
      method: "PUT",
      body: new Uint8Array(1000),
    });
    return r.status;
  });
  expect(stray).toBe(204);
  const pruned = await cache(host, "prune");
  expect(pruned.removed).toBe(1);
  expect(pruned.packages).toBe(before.packages);

  // DELETE of one file.
  expect(
    await host.evaluate(
      async () =>
        (
          await fetch("/__cellb/projects/pkgstore/files/pkgs/not-used@0.0.0.pack", {
            method: "DELETE",
          })
        ).status,
    ),
  ).toBe(404);

  // A build's lease (another tab's, here) holds every clean-up off until it is given back.
  const lease = (method: string) =>
    host.evaluate(
      async ([store, method]) => (await fetch(`${store}/admin/lease?id=test`, { method })).status,
      [STORE, method],
    );
  expect(await lease("POST")).toBe(200);
  expect((await cache(host, "stats")).builds).toBe(1);
  await expect(cache(host, "prune")).rejects.toThrow(/1 build is using the package store/);
  await expect(cache(host, "clear")).rejects.toThrow(/using the package store/);
  expect(await lease("DELETE")).toBe(200);

  // A lock that cannot be read stops the prune: nothing is removed.
  const putText = (path: string, text: string) =>
    host.evaluate(
      async ([url, text]) => (await fetch(url, { method: "PUT", body: text })).status,
      [`${STORE}/files${path}`, text],
    );
  expect(await putText("/locks/broken.json", "[not json")).toBe(204);
  await expect(cache(host, "prune")).rejects.toThrow(/cannot be read/);
  expect((await cache(host, "stats")).packages).toBe(before.packages);

  // Forget: the locks (the broken one too) and the version index.
  const unlocked = await cache(host, "forget");
  expect(unlocked.removed).toBe(3);
  expect(unlocked.locks).toBe(0);
  expect(unlocked.packages).toBe(before.packages);

  const cleared = await cache(host, "clear");
  expect(cleared.files).toBe(0);
  expect(cleared.size).toBe(0);

  // The rebuild downloads every package again (the store is empty) and serves the site.
  await host.reload();
  const log = await built(host);
  const downloads = Number(/package store: (\d+) packages downloaded/.exec(log)?.[1] ?? -1);
  expect(downloads).toBeGreaterThan(10);
  const after = await cache(host, "stats");
  expect(after.locks).toBe(1);
  expect(after.packages).toBe(before.packages);
  const site = await context.newPage();
  expect((await site.goto("/"))?.status()).toBe(200);
});
