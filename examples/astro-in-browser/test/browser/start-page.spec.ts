import { expect, test } from "@playwright/test";

// The chooser (/__cellb/start.html): reachable while a tab runs a site at the origin's root,
// and where a visit lands when no tab runs one, with what was built last and the path asked
// for carried on to the host page.
test("the chooser stays reachable once a site is built", async ({ context }) => {
  test.setTimeout(300_000);
  const host = await context.newPage();
  await host.goto("/__cellb/");
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 240_000 },
  );
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await expect(host.getByRole("link", { name: "Choose another app" })).toHaveAttribute(
    "href",
    "/__cellb/start.html",
  );

  // While the host tab runs the site: `/` is the site, the chooser is still there.
  const page = await context.newPage();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "An Astro site built in this browser" }),
  ).toBeVisible();
  await page.goto("/__cellb/start.html");
  await expect(page.getByRole("link", { name: "EmDash" })).toHaveAttribute(
    "href",
    "/__cellb/emdash.html",
  );
  await expect(page.locator("#last")).toContainText("Built last in this browser: the small");

  // No tab runs the site: a visit to one of its paths lands on the chooser, which passes the
  // path on to the host pages.
  // (Right after the close, the ServiceWorker may still route to the lost tab: "the handler was
  // lost while this request was in flight". A later visit finds no tab.)
  await host.close();
  await expect(async () => {
    await page.goto("/posts/hello");
    expect(page.url()).toMatch(/\/__cellb\/start\.html\?next=/);
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
  await expect(page.locator("#next")).toContainText("/posts/hello");
  await expect(page.getByRole("link", { name: "EmDash" })).toHaveAttribute(
    "href",
    "/__cellb/emdash.html?next=%2Fposts%2Fhello",
  );

  // Picking the small app again builds it, and its link opens the path asked for.
  await page.getByRole("link", { name: "A small Astro app" }).click();
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
    timeout: 240_000,
  });
  await expect(page.locator("#open")).toHaveAttribute("href", "/posts/hello");
});
