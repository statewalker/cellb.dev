// The isolated pool in Chromium: one Web Worker per container, for Wasmer and for Lifo.
import { expect, test } from "@playwright/test";

for (const runtime of ["wasmer", "lifo"]) {
  test(`isolated pool (${runtime}): runs, page-owned FilesApi, no leaks, waiting requests, timeouts`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto("/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const r = await page.evaluate((name) => (window as any).__isolated(name), runtime);
    console.log(`${runtime}: 2 containers warm in ${r.warmMs} ms`);
    expect(r.print).toMatchObject({ exitCode: 0, stdout: "42\n" });
    expect(r.upper).toBe("FROM THE PAGE");
    expect(r.probe).toEqual([[], false]);
    expect(r.queued).toEqual(["42\n", "42\n", "42\n", "42\n"]);
    expect(r.spin).toBe(true);
    expect(r.after).toBe("42\n");
  });
}
