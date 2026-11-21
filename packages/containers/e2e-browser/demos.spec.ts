// The browser demos (examples/browser-demos): python/ (Wasmer) and notebook/ (Observable Framework's
// preview in a Lifo container, shown in a frame through webrun-http-browser's ServiceWorker, live
// reload over a WebSocket into the container. UPDATE_SCREENSHOTS=1 retakes docs/images/. Needs the npm
// registry and jsDelivr (the build step).
import { expect, test } from "@playwright/test";

const url = `http://localhost:${Number(process.env.PW_NOTEBOOK_PORT ?? 5198)}/`;
// UPDATE_SCREENSHOTS=1 writes them into docs/images; otherwise into the test's output folder
const shot = (name: string) =>
  process.env.UPDATE_SCREENSHOTS
    ? `docs/images/${name}.png`
    : test.info().outputPath(`${name}.png`);

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

test("notebook: interactive, edited live, served from a container", async ({ page }) => {
  test.setTimeout(600_000);
  const missing: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${url}notebook/`);
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
  await page.screenshot({ path: shot("notebook-1-loaded") });

  // interactive: the frequency slider drives the plot and the value
  await frame.locator('input[type="range"]').first().fill("6");
  await expect(frame.locator("strong")).toHaveText((1 * Math.sin(6)).toFixed(3));
  await page.screenshot({ path: shot("notebook-2-slider") });

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
  await page.screenshot({ path: shot("notebook-3-edited") });
  console.log("responses >= 400:", missing);
});

test("python: a script in a fresh Wasmer container per run, against the page's files", async ({
  page,
}) => {
  test.setTimeout(300_000);
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${url}python/`);
  await page.waitForFunction(
    () => ["ready", "error"].includes(document.body.dataset.state ?? ""),
    null,
    { timeout: 240_000 },
  );
  expect(await page.getAttribute("body", "data-state")).toBe("ready");
  const run = async () => {
    await page.click("#run");
    await expect(page.locator("#run")).toBeEnabled({ timeout: 120_000 });
    return { out: await page.textContent("#output"), files: await page.textContent("#files") };
  };
  const first = await run();
  expect(first.out).toMatch(/Python 3\.\d+/);
  expect(first.out).toContain("5 cities, mean 24.8 °C, hottest: Cairo");
  expect(first.out).toMatch(/network: none/);
  expect(first.files).toContain("hottest=Cairo");
  await page.screenshot({ path: shot("python-1-run") });
  // a fresh container each run: nothing of the last one is left
  await page.fill(
    "#code",
    "import os; print(sorted(os.listdir('/data')), os.path.exists('/tmp/left-over'))\nopen('/tmp/left-over','w').write('x')",
  );
  expect((await run()).out?.trim()).toBe("['temperatures.csv'] False");
  expect((await run()).out?.trim()).toBe("['temperatures.csv'] False");
});
