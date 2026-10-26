import { expect, test } from "@playwright/test";

// Hypothesis check: is a page that navigates under an already active ServiceWorker controlled?
const state = (p: import("@playwright/test").Page) =>
  p.evaluate(async () => ({
    controller: !!navigator.serviceWorker.controller,
    regs: (await navigator.serviceWorker.getRegistrations()).map((r) => [r.scope, !!r.active]),
  }));

test("SW control on navigation", async ({ context, browserName }) => {
  const t1 = await context.newPage();
  await t1.goto("/sharded/?passive");
  await t1.waitForFunction(() => document.body.dataset.ready === "true");
  console.log(browserName, "t1 first load", JSON.stringify(await state(t1)));
  await t1.reload();
  await t1.waitForFunction(() => document.body.dataset.ready === "true");
  console.log(browserName, "t1 after reload", JSON.stringify(await state(t1)));
  const t2 = await context.newPage();
  await t2.goto("/sharded/?passive");
  await t2.waitForFunction(() => document.body.dataset.ready === "true");
  console.log(browserName, "t2 new tab", JSON.stringify(await state(t2)));
  // A navigation made by the page itself, not by Playwright.
  await t2.evaluate(() => location.assign("/sharded/?passive&self"));
  await t2.waitForURL(/self/);
  await t2.waitForFunction(() => document.body.dataset.ready === "true");
  console.log(browserName, "t2 self-navigated", JSON.stringify(await state(t2)));
  expect(true).toBe(true);
});
