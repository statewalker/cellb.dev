import { expect, type Page, test } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
}

test("a Python container in the engine worker, driven from the page", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => (window as any).__http());
  expect(r.crossOriginIsolated).toBe(true);
  expect(r.text).toBe("hello /browser");
  expect(r.exec).toMatchObject({ exitCode: 0, stdout: "wasm32\n" });
  expect(r.running).toBe(false);
  // Wasmer's core runs in the worker: the page never stalls the way it does with new Wasmer() on it.
  expect(r.maxGapMs).toBeLessThan(250);
});

test("a FilesApi on the page's main thread, mounted into a container in a worker", async ({
  page,
}) => {
  await open(page);
  const r = await page.evaluate(() => (window as any).__files());
  expect(r.stderr).toBe("");
  expect(r.guest).toEqual({
    list: ["docs"],
    read: "hello from the page",
    secret: false,
    docsWrite: "PermissionError",
  });
  expect(r.pageSees).toBe("written by python in a worker");
  expect(r.docsAfter).toBe("hello from the page");
});

test("the Python example as a cellb project in a worker, one container per cell", async ({
  page,
}) => {
  await open(page);
  const r = await page.evaluate(() =>
    (window as any).__cellb(["/hello?cell=alpha", "/again?cell=alpha", "/hello?cell=beta"]),
  );
  expect(r.error).toBeUndefined();
  expect(r.unsupported).toContain("containers[PyRunner] (cellb runs no containers)");
  expect(r.out.map((x: any) => [x.cell, x.visits, x.fromContainer.cell])).toEqual([
    ["alpha", 1, "alpha"],
    ["alpha", 2, "alpha"],
    ["beta", 1, "beta"],
  ]);
});
