import { test } from "@playwright/test";

test("probe EmDash's admin hydration", async ({ context }) => {
  test.setTimeout(600_000);
  const host = await context.newPage();
  await host.goto("/__cellb/emdash.html");
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 400_000, polling: 2000 },
  );
  const site = await context.newPage();
  site.on("console", (m) => console.log(`[admin ${m.type()}] ${m.text().slice(0, 700)}`));
  site.on("pageerror", (e) => console.log(`[admin pageerror] ${e.stack?.slice(0, 900)}`));
  site.on("requestfailed", (r) =>
    console.log(`[admin failed] ${r.url()} ${r.failure()?.errorText}`),
  );
  site.on(
    "response",
    (r) =>
      r.url().includes("/_astro/") &&
      console.log(`[admin asset] ${r.status()} ${r.url()} ${r.headers()["content-type"]}`),
  );
  await site.goto("/_emdash/admin/setup", { waitUntil: "domcontentloaded" });
  await site.waitForTimeout(20_000);
  console.log("[admin html]", (await site.content()).slice(0, 1500));
  await site.screenshot({ path: "screenshots/emdash/probe-admin.png" });
});
