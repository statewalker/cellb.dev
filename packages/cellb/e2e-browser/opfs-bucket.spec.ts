import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";

// A browser host on a celld fleet bucket kept in OPFS (browser-host.ts, `bucket: { opfs }`): a
// worker serves the cells, releases them on close, and the next worker — another "node" —
// takes them over through celld's ownership protocol and continues from the LTX logs. No server.
test("cells, facets and R2 objects continue across browser nodes through an OPFS bucket", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/projects/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const fleet = `fleet-${Date.now().toString(36)}`;
  const run = async (name: string, node: string, paths: string[], pool?: string) => {
    const project = await bundleProjectForBrowser(name);
    const r = await page.evaluate((job) => (window as any).__runProject(job), {
      project,
      scenario: name,
      paths,
      pool,
      bucket: { opfs: fleet, node },
    });
    expect(r.ok, r.error).toBe(true);
    return (r.answers as string[]).map((t) => JSON.parse(t));
  };
  const n = (xs: { n: number }[]) => xs.map((x) => x.n);
  // browser-a keeps its SQLite pool: taking the cell back, it continues from browser-b's write,
  // not from its own older local database.
  const poolA = `cells-${fleet}-a`;
  const inc = ["/increment?name=x"];
  expect(n(await run("counter", "browser-a", [...inc, ...inc], poolA))).toEqual([1, 2]);
  expect(n(await run("counter", "browser-b", inc))).toEqual([3]);
  expect(n(await run("counter", "browser-a", inc, poolA))).toEqual([4]);
  expect(await run("facet-store", "browser-a", ["/"])).toEqual([{ facet: 1, parent: 1 }]);
  expect(await run("facet-store", "browser-b", ["/"])).toEqual([{ facet: 2, parent: 2 }]);
  expect(await run("r2-handoff", "browser-a", ["/put?key=k&body=from-a&who=a"])).toEqual([
    { put: "k" },
  ]);
  const [got] = await run("r2-handoff", "browser-b", ["/get?key=k"]);
  expect(got).toEqual(
    expect.objectContaining({ body: "from-a", customMetadata: { Who: "a", note: "déjà vu ✓" } }),
  );
});
