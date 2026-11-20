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
  expect(r.unsupported).toEqual([]); // the container class runs: ctx.container
  expect(r.out.map((x: any) => [x.cell, x.visits, x.fromContainer.cell])).toEqual([
    ["alpha", 1, "alpha"],
    ["alpha", 2, "alpha"],
    ["beta", 1, "beta"],
  ]);
});

test("the PHP example: PHP's built-in server in a cellb cell", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => (window as any).__cellb(["/?cell=alpha"], "php"));
  expect(r.error).toBeUndefined();
  expect(r.out[0]).toMatchObject({
    cell: "alpha",
    visits: 1,
    fromContainer: { uri: "/?cell=alpha" },
  });
  expect(r.out[0].fromContainer.php).toMatch(/^8\./);
});

test("the Node example: node:http in wasmer/edgejs (JSPI) in a cellb cell", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => (window as any).__cellb(["/hello?cell=alpha"], "node"));
  expect(r.error).toBeUndefined();
  expect(r.out[0]).toMatchObject({ cell: "alpha", fromContainer: { url: "/hello?cell=alpha" } });
  expect(r.out[0].fromContainer.node).toMatch(/^v\d+/);
});

test("the pool example: each cell runs its code on its own FilesApi, nothing leaks", async ({
  page,
}) => {
  await open(page);
  const r = await page.evaluate(() =>
    (window as any).__cellb(
      [
        {
          path: "/run?cell=alpha",
          method: "POST",
          body: "import os\nopen('/data/note.txt','w').write('alpha')\nopen('/tmp/t','w').write('x')\nprint(os.environ['CELL'])",
        },
        {
          path: "/run?cell=beta",
          method: "POST",
          body: "import os, json\nprint(json.dumps([os.listdir('/data'), os.path.exists('/tmp/t')]))",
        },
        { path: "/run?cell=alpha", method: "POST", body: "print(open('/data/note.txt').read())" },
        "/files?cell=alpha",
        "/files?cell=beta",
      ],
      "pool",
    ),
  );
  expect(r.error).toBeUndefined();
  const [a1, b1, a2, fa, fb] = r.out;
  expect(a1).toMatchObject({ exitCode: 0, stdout: "alpha\n" });
  expect(JSON.parse(b1.stdout)).toEqual([[], false]);
  expect(a2.stdout).toBe("alpha\n");
  expect(fa).toEqual(["/note.txt"]);
  expect(fb).toEqual([]);
});
