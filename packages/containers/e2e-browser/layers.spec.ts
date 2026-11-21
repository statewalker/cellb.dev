// Layered files in Chromium: a Lifo build container with egress (the page's network) installs into
// a FilesApi owned by the page; Lifo containers without network run on it, read-only. Then the same
// with Observable Framework (examples/observable-framework). Needs the npm registry and jsDelivr.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
});

test("layered files: npm install with egress, then runs read-only without network", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const r = await page.evaluate(() => (window as any).__layers());
  console.log(`install in ${r.installMs} ms`);
  expect(r.install.exitCode, r.install.stderr).toBe(0);
  expect(r.installed).toBe("2.1.3");
  expect(JSON.parse(r.first), r.firstErr).toEqual({ result: "2m", refused: "EACCES" });
  expect(r.out).toBe("2m");
  expect(JSON.parse(r.second)).toEqual([false, "1s"]);
  expect(r.patched).toBe("patched\n");
  expect(r.topPatched).toBe("module.exports = () => 'patched'");
  expect(r.base).not.toContain("patched");
  expect(r.net).toMatch(/^blocked .*no egress/);
});

test("Observable Framework: install and adapt with egress, build sites without network", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const r = await page.evaluate(() => (window as any).__framework());
  for (const s of r.steps) console.log(`${s.argv.slice(0, 60)}: exit ${s.exitCode} in ${s.ms} ms`);
  for (const s of r.steps) expect(s.exitCode, `${s.argv}\n${s.stderr}`).toBe(0);
  const [hello, about] = r.sites;
  console.log(`site builds: ${hello.ms} ms, ${about.ms} ms`);
  expect(hello.exitCode, `${hello.stdout}\n${hello.stderr}`).toBe(0);
  expect(hello.html).toMatch(
    /<h1 id="hello-from-a-container"[\s\S]*Hello from a container<\/a><\/h1>/,
  );
  expect(about.exitCode, about.stderr).toBe(0);
  expect(about.html).toMatch(/<h1 id="about"/);
  expect(about.dist).not.toContain("index.html");
  expect(r.layerDist).toBe(false);
});

test("Observable Framework preview: live reload through a WebSocket into the container", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const r = await page.evaluate(() => (window as any).__preview());
  console.log(`preview up in ${r.startMs} ms; update ${r.updateMs} ms after the edit`);
  expect(r.pageHasVersionOne).toBe(true);
  expect(r.hash).toBeTruthy();
  expect(r.welcome).toBe(true);
  expect(r.edit).toBe(0);
  expect(r.update).toContain("version two");
  expect(r.topHasEdit).toBe(true);
});
