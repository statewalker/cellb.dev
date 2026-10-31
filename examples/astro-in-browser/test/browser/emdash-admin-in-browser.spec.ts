import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { adminFlow, POST_PATH, POST_TITLE } from "../../../emdash/test/static/admin-flow.ts";

// EmDash built IN the browser, then used as a person would: the admin's setup wizard, a passkey,
// a post with a featured image (R2), published, the public site (the same flow as the static
// build's spec). Then the data's persistence on the LTX storage across a reload of the host tab
// (which builds the site again), and a second host tab taking the site's shard over when the
// first closes (the per-cell Web Locks of the LTX store change hands). Screenshots go to
// screenshots/emdash-admin/.
const shots = join(import.meta.dirname, "../../screenshots/emdash-admin");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage });

/** A host tab that builds the site and serves it; resolves once the site answers. */
async function openHost(context: BrowserContext, log: (m: string) => void): Promise<Page> {
  const host = await context.newPage();
  host.on("console", (m) => {
    const t = m.text();
    if (/^\[build\] (built in|shards joined)|unsupported|ltx-store|ltx-vfs|Broken/.test(t))
      log(`host: ${t.slice(0, 300)}`);
  });
  host.on("pageerror", (e) => log(`host pageerror: ${e.message}`));
  await host.goto("/__cellb/emdash.html");
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 600_000, polling: 2000 },
  );
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  return host;
}

/**
 * The published post, read back with its image (from D1 and R2). Reloaded until it shows, for
 * up to `within` ms: a request in flight when its shard's tab closes fails ("Owner of cell shard
 * 0 was lost"), as a person would see it before reloading, while another tab takes the shard.
 */
async function expectPost(page: Page, origin: string, within = 60_000) {
  const until = Date.now() + within;
  for (;;) {
    await page
      .goto(`${origin}${POST_PATH}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
      .catch(() => {});
    const shown = await page
      .getByRole("heading", { name: POST_TITLE })
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    if (shown) break;
    if (Date.now() > until)
      throw new Error(
        `${POST_PATH} not served: ${(await page.textContent("body"))?.slice(0, 300)}`,
      );
  }
  const img = page.locator("main img").first();
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

test("EmDash built in the browser: the admin flow, a reload, a second tab", async ({
  context,
  baseURL,
}) => {
  test.setTimeout(1_500_000);
  const origin = baseURL as string;
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  try {
    const host = await openHost(context, log);
    await shot(host, "01-host-tab");
    log("built and running");

    const site = await context.newPage();
    site.on("console", (m) => m.type() === "error" && log(`site: ${m.text().slice(0, 200)}`));
    await adminFlow(context, site, origin, {
      log,
      shot,
      title: "Built in this Tab",
      tagline: "EmDash, compiled and run by the browser",
      body:
        "This post was written in EmDash's admin. EmDash itself was built from its sources in " +
        "this browser tab, and runs there on cellb, its data in SQLite on LTX files in OPFS.",
    });

    // Persistence: the host tab reloads (and builds the site again); the site's Durable
    // Objects reopen from their LTX files.
    await site.close();
    await host.reload();
    await host.waitForFunction(
      () => document.body.dataset.ready === "true" || document.body.dataset.error,
      null,
      { timeout: 600_000, polling: 2000 },
    );
    expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
    log("host reloaded and rebuilt");
    const after = await context.newPage();
    await expectPost(after, origin);
    await shot(after, "10-post-after-reload", true);
    log("post and image read back after the reload");

    // Two tabs: a second host tab joins; the first closes, and the second takes the shard
    // over, its cells' LTX files and their Web Locks with it.
    const second = await openHost(context, log);
    log("second host tab running");
    await expectPost(after, origin);
    log("post served with two host tabs open");
    await host.close();
    log("first host tab closed");
    await expectPost(after, origin, 180_000);
    await shot(after, "11-post-from-the-second-tab", true);
    log("post served by the second tab");
    // The site still writes: EmDash's setup status is read and its session is written.
    const status = await after.evaluate(async () => {
      const r = await fetch("/_emdash/api/setup/status");
      return [r.status, await r.text()];
    });
    expect(status[0]).toBe(200);
    await second.close();
  } catch (err) {
    for (const [i, p] of context.pages().entries())
      await p.screenshot({ path: join(shots, `failed-${i}.png`), timeout: 10_000 }).catch(() => {});
    throw err;
  }
});
