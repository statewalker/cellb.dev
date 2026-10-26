import { expect, test } from "@playwright/test";

// A request body survives the retry at the owner and the scheme restored on the owner's link,
// the two places cellb rebuilds a request from its body (Firefox has no Request.body).
test("a POST on a node that does not own the cell reaches the owner with its body", async ({
  page,
}) => {
  await page.goto("/peers/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const r = await page.evaluate(() => (window as any).__peers());
  expect(r).toEqual({ first: { n: 1, body: null }, viaB: { n: 2, body: "via B" } });
});
