import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// The host page builds the Astro app in the browser and runs it on cellb; the built site is
// then opened in another tab and checked. Screenshots go to screenshots/.
const shots = join(import.meta.dirname, "../../screenshots");
mkdirSync(shots, { recursive: true });
const shot = (p: Page, name: string, fullPage = false) =>
  p.screenshot({ path: join(shots, `${name}.png`), fullPage });

test("an Astro app built entirely in the browser runs on cellb", async ({ context }) => {
  test.setTimeout(300_000);
  const host = await context.newPage();
  host.on("console", (m) => console.log(`[host] ${m.type()} ${m.text().slice(0, 300)}`));
  await host.goto("/__cellb/");
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 240_000 },
  );
  console.log((await host.locator("#log").textContent())?.slice(0, 3000));
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  expect(await host.evaluate(() => crossOriginIsolated)).toBe(true);
  await shot(host, "01-host-build-log");

  const site = await context.newPage();
  const res = await site.goto("/");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-built-in"]).toBe("browser");
  await expect(
    site.getByRole("heading", { name: "An Astro site built in this browser" }),
  ).toBeVisible();
  await shot(site, "02-site-home", true);
  await site.getByRole("link", { name: /Hello from the browser/ }).click();
  await expect(site.getByText("No Node.js was involved in building it.")).toBeVisible();
  await shot(site, "03-site-post", true);
  await site.goto("/api/time");
  expect(JSON.parse((await site.locator("body").textContent()) ?? "{}").path).toBe("/api/time");
  await shot(site, "04-site-api");
});
