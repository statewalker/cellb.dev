import { expect, type Page, test } from "@playwright/test";

// The chooser (/__cellb/start.html) and saved builds: an app compiled once is saved in the
// browser and launched from the chooser without compiling, until it is rebuilt. The chooser is
// reachable while a tab runs a site at the origin's root, and is where a visit lands when no
// tab runs one, the path asked for passed on (only a path of this origin).
const ready = async (host: Page) => {
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 240_000 },
  );
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  return (await host.locator("#log").textContent()) ?? "";
};
const row = (page: Page, app: string) => page.locator(`tr[data-app="${app}"]`);

test("apps are saved, launched from the chooser and rebuilt on request", async ({ context }) => {
  test.setTimeout(400_000);
  // Nothing saved yet: both apps are "Build and launch".
  const page = await context.newPage();
  await page.goto("/__cellb/start.html");
  await expect(row(page, "app").locator(".state")).toContainText("Not built in this browser yet");
  await expect(row(page, "emdash").getByRole("link", { name: "Build and launch" })).toBeVisible();
  await expect(row(page, "app").getByRole("link", { name: "Rebuild" })).toHaveCount(0);

  // The first launch compiles, shows its progress, and saves the build.
  await row(page, "app").getByRole("link", { name: "Build and launch" }).click();
  const host = page;
  const first = await ready(host);
  expect(first).toContain("build saved");
  await expect(host.locator("#progress")).toHaveJSProperty("value", 100);
  // A cold build: the packages downloaded stay beside the stage, not in its place.
  await expect(host.locator("#phase")).toHaveText(
    /^Running · \d+ packages downloaded · 100% · \d+ s$/,
  );
  await expect(host.getByRole("link", { name: "Choose another app" })).toHaveAttribute(
    "href",
    "/__cellb/start.html",
  );

  // While the host tab runs the site: `/` is the site, the chooser is still there and lists
  // the saved build.
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByRole("heading", { name: "An Astro site built in this browser" }),
  ).toBeVisible();
  await other.goto("/__cellb/start.html");
  await expect(row(other, "app").locator(".state")).toContainText("Saved build of");
  await expect(row(other, "app").locator(".state")).toContainText("Launched last");
  await expect(row(other, "app").getByRole("link", { name: "Rebuild" })).toHaveAttribute(
    "href",
    "/__cellb/?rebuild",
  );

  // No tab runs the site: a visit to one of its paths lands on the chooser, which passes the
  // path on. (Right after the close, the ServiceWorker may still route to the lost tab: "the
  // handler was lost while this request was in flight". A later visit finds no tab.)
  await host.close();
  await expect(async () => {
    await other.goto("/posts/hello");
    expect(other.url()).toMatch(/\/__cellb\/start\.html\?next=/);
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
  await expect(other.locator("#next")).toContainText("/posts/hello");
  await expect(row(other, "app").getByRole("link", { name: "Launch" })).toHaveAttribute(
    "href",
    "/__cellb/?next=%2Fposts%2Fhello",
  );

  // Launch: the saved build runs, nothing is compiled, and the link opens the path asked for.
  await row(other, "app").getByRole("link", { name: "Launch" }).click();
  const second = await ready(other);
  expect(second).toContain("saved build of");
  expect(second).not.toContain("bundling the server");
  expect(await other.evaluate(() => document.body.dataset.saved ?? null)).not.toBeNull();
  await expect(other.locator("#open")).toHaveAttribute("href", "/posts/hello");
  const site = await context.newPage();
  await site.goto("/posts/hello");
  await expect(site.getByText("No Node.js was involved in building it.")).toBeVisible();

  // A reload runs the saved build too; Rebuild compiles again and saves the new build.
  await other.reload();
  expect(await ready(other)).toContain("saved build of");
  await other.getByRole("link", { name: "Rebuild" }).click();
  const rebuilt = await ready(other);
  expect(rebuilt).toContain("bundling the server");
  expect(rebuilt).toContain("build saved");
  expect(new URL(other.url()).searchParams.has("rebuild")).toBe(false); // a reload runs it
});

test("the chooser passes on only a path of this origin", async ({ page }) => {
  // As they appear in the query: `\`, a tab and a newline (the browser drops these two) and
  // `//` make another origin of the path.
  for (const raw of [
    "/%5Cevil.example",
    "/%09/evil.example",
    "/%0A/evil.example",
    "//evil.example",
    "https%3A%2F%2Fevil.example%2F",
    "/__cellb/start.html",
  ]) {
    await page.goto(`/__cellb/start.html?next=${raw}`);
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(page.locator("#next")).toBeHidden();
    await expect(row(page, "app").locator("a").first()).toHaveAttribute("href", "/__cellb/");
  }
  await page.goto(`/__cellb/start.html?next=${encodeURIComponent("/posts/a?x=1#y")}`);
  await expect(page.locator("#next")).toContainText("/posts/a?x=1#y");
});
