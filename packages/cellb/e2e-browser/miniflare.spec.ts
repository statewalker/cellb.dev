import { expect, test } from "@playwright/test";

// Miniflare's KV and D1 simulators (unchanged, vendored) + workerd's D1 client, in a
// Chromium Dedicated Worker on OPFS; state must survive a worker restart.
test("KV and D1 bindings from Miniflare/workerd code run in the browser and persist in OPFS", async ({
  page,
}) => {
  await page.goto("/miniflare/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate(async () => {
    const mf = (window as any).__mf;
    const tag = `t${Date.now()}`;
    await mf({ op: "kv-put", key: `${tag}/a`, value: "alpha ✓", metadata: { n: 1 } });
    await mf({ op: "kv-put", key: `${tag}/b`, value: "beta" });
    const first = await mf({ op: "d1", body: `${tag}-1` });
    (window as any).__mfRestart(); // new worker: everything must come back from OPFS
    const got = await mf({ op: "kv-get", key: `${tag}/a` });
    const listed = await mf({ op: "kv-list", prefix: `${tag}/` });
    const second = await mf({ op: "d1", body: `${tag}-2` });
    return {
      got,
      listed,
      first: first.filter((b: string) => b.startsWith(tag)),
      second: second.filter((b: string) => b.startsWith(tag)),
    };
  });
  expect(r.got).toEqual({ value: "alpha ✓", metadata: { n: 1 } });
  expect(r.listed).toEqual([expect.stringMatching(/\/a$/), expect.stringMatching(/\/b$/)]);
  expect(r.first).toHaveLength(1);
  expect(r.second).toEqual([r.first[0], expect.stringMatching(/-2$/)]);
});
