import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";

// The host app (browser/host): a project folder runs in a worker on an OPFS fleet bucket and is
// served through the ServiceWorker at its own URL; the page (and an iframe) talk to it over
// real HTTP. A second start — a new browser node — continues the cells from the bucket.
const examples = resolve(import.meta.dirname, "../../conformance/celld-examples");
const filesOf = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
};

test("a project served over HTTP from the browser, its cells continuing across nodes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/host/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const fleet = `host-fleet-${Date.now().toString(36)}`;
  const run = (node: string) =>
    page.evaluate(
      async ({ files, fleet, node }) => {
        const host = (window as any).__host;
        const map = new Map(
          Object.entries(files).map(([p, b]) => [
            p,
            Uint8Array.from(atob(b as string), (c) => c.charCodeAt(0)),
          ]),
        );
        const { appUrl } = await host.startHost({
          files: map,
          bucket: { opfs: fleet, node },
          pool: `pool-${node}-${fleet}`,
        });
        const get = async (path: string) => (await fetch(new URL(path, appUrl))).json();
        const answers = [await get("increment?name=a"), await get("increment?name=a")];
        const owned = await host.ownedCells();
        await host.stopHost();
        return { appUrl, answers, owned };
      },
      { files: filesOf(join(examples, "counter")), fleet, node },
    );
  const a = await run("browser-a");
  expect(a.appUrl).toMatch(/^http:\/\/localhost:\d+\//);
  expect(a.answers.map((x: { n: number }) => x.n)).toEqual([1, 2]);
  expect(a.owned).toEqual([expect.stringMatching(/^Counter:[0-9a-f]{64}$/)]);
  const b = await run("browser-b");
  expect(b.answers.map((x: { n: number }) => x.n)).toEqual([3, 4]);
});

// The page itself, as a person uses it: choose the project folder, a node name and the OPFS
// bucket, press Start; the app appears in the iframe and the owned cells are listed.
test("the host page: folder picker, bucket choice, app in the iframe, owned cells", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/host/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  await page.setInputFiles("#project", join(examples, "counter"));
  await page.fill("#node", "browser-form");
  await page.selectOption("#bucket-kind", "opfs");
  await page.fill("#opfs", `form-fleet-${Date.now().toString(36)}`);
  await page.click("button[type=submit]");
  await expect(page.locator("#status")).toHaveText(/^running/, { timeout: 30_000 });
  const appUrl = await page.locator("#app-link").getAttribute("href");
  expect(appUrl).toMatch(/^http:\/\/localhost:\d+\//);
  // the iframe shows the app's own page; requests go to it over HTTP
  await page
    .locator("#app")
    .evaluate((f: HTMLIFrameElement, u) => (f.src = `${u}increment?name=form`), appUrl);
  await expect(page.frameLocator("#app").locator("body")).toContainText('"n":1', {
    timeout: 15_000,
  });
  await page.click("#refresh-owned");
  await expect(page.locator("#owned")).toContainText(/Counter:[0-9a-f]{64}/);
  await page.click("#stop");
  await expect(page.locator("#status")).toHaveText("stopped");
});
