// The interactive notebook example (examples/observable-framework/notebook): Observable Framework's
// preview in a Lifo container, shown in a frame through webrun-http-browser's ServiceWorker, live
// reload over a WebSocket into the container. UPDATE_SCREENSHOTS=1 retakes docs/images/. Needs the npm
// registry and jsDelivr (the build step).
import { expect, test } from "@playwright/test";

const url = `http://localhost:${Number(process.env.PW_NOTEBOOK_PORT ?? 5198)}/`;
// UPDATE_SCREENSHOTS=1 writes them into docs/images; otherwise into the test's output folder
const shot = (name: string) =>
  process.env.UPDATE_SCREENSHOTS
    ? `docs/images/notebook-${name}.png`
    : test.info().outputPath(`notebook-${name}.png`);

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

test("notebook: interactive, edited live, served from a container", async ({ page }) => {
  test.setTimeout(600_000);
  const missing: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => ["ready", "error"].includes(document.body.dataset.state ?? ""),
    null,
    {
      timeout: 540_000,
    },
  );
  console.log(await page.textContent("#status"));
  console.log(await page.textContent("#log"));
  expect(await page.getAttribute("body", "data-state")).toBe("ready");

  const frame = page.frameLocator("#preview");
  await expect(frame.locator("h1")).toHaveText("Wave explorer");
  await expect(frame.locator("svg").first()).toBeVisible();
  await expect(frame.locator("strong")).toHaveText("0.909");
  await page.screenshot({ path: shot("1-loaded") });

  // interactive: the frequency slider drives the plot and the value
  await frame.locator('input[type="range"]').first().fill("6");
  await expect(frame.locator("strong")).toHaveText((1 * Math.sin(6)).toFixed(3));
  await page.screenshot({ path: shot("2-slider") });

  // live reload: an edit is pushed to the frame, which updates in place
  const preview = page.frames().find((f) => f.url().includes("/nb/"));
  await preview?.evaluate(() => Object.assign(window, { __sameDocument: true }));
  const edited = (await page.inputValue("#editor"))
    .replace("# Wave explorer", "# Wave explorer, edited live")
    .replace('stroke: "steelblue"', 'stroke: "crimson"')
    .replace("At *t* = 1", "Peak-to-peak: **${(2 * amplitude).toFixed(1)}**.\n\nAt *t* = 1");
  await page.fill("#editor", edited);
  await expect(frame.locator("h1")).toHaveText("Wave explorer, edited live", { timeout: 30_000 });
  await expect(frame.locator('[stroke="crimson"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(frame.getByText("Peak-to-peak:")).toBeVisible();
  // the same document (no reload), and the slider kept its value
  expect(
    await preview?.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument),
  ).toBe(true);
  await expect(frame.locator('input[type="range"]').first()).toHaveValue("6");
  await page.screenshot({ path: shot("3-edited") });
  console.log("responses >= 400:", missing);
});
