import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { sampleHeaps } from "./heap-sampler.ts";

// EmDash's blog template, built in the browser (its astro.config.mjs and integrations run in
// the builder; Astro's compiler and esbuild as wasm; every package from the npm registry),
// run on cellb in the tab, set up through EmDash's API, then exported as static files.
const shots = join(import.meta.dirname, "../../screenshots/emdash");
mkdirSync(shots, { recursive: true });
const shot = (p: Page, name: string, fullPage = false) =>
  p.screenshot({ path: join(shots, `${name}.png`), fullPage });

test("EmDash: built, run and exported entirely in the browser", async ({ context }) => {
  test.setTimeout(900_000);
  const host = await context.newPage();
  host.on(
    "console",
    (m) => /^\[(build|memory)\]/.test(m.text()) && console.log(m.text().slice(0, 400)),
  );
  host.on(
    "console",
    (m) =>
      (/^\[(build|shard)\]/.test(m.text()) || m.type() === "error" || m.type() === "warning") &&
      console.log(`[${m.type()}] ${m.text().slice(0, 900)}`),
  );
  host.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  // Build and runtime problems that do not fail the build: each is a gap in what was built.
  const gaps: string[] = [];
  host.on("console", (m) => {
    const t = m.text();
    if (
      /skipped the script|session driver is configured|: unsupported: |cellb ltx-store: .* failed/.test(
        t,
      )
    )
      gaps.push(t.slice(0, 300));
  });
  host.on("worker", (w) => {
    console.log(`[worker] ${w.url()}`);
    (w as any).on?.("console", (m: any) =>
      console.log(`[worker ${m.type()}] ${m.text().slice(0, 900)}`),
    );
    w.on("close", () => console.log(`[worker closed] ${w.url()}`));
  });
  context.on("serviceworker", (w) =>
    w.on("console", (m) => console.log(`[sw ${m.type()}] ${m.text().slice(0, 500)}`)),
  );
  const heaps = process.env.EMDASH_HEAP ? await sampleHeaps(host) : undefined;
  await host.goto(`/__cellb/emdash.html${process.env.EMDASH_STORE ? "?store" : ""}`);
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 840_000, polling: 2000 },
  );
  expect(gaps).toEqual([]);
  console.log((await host.locator("#log").textContent())?.slice(-2500));
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await shot(host, "01-host-build-log");
  if (heaps)
    console.log(
      `[heap] peaks: ${heaps
        .stop()
        .slice(0, 10)
        .map(([k, v]) => `${k} ${(v / 1e6).toFixed(0)} MB`)
        .join(", ")}`,
    );

  // EmDash's setup step (the template's seed into D1), as its wizard calls it.
  const seeded = await host.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const r = await fetch("/_emdash/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-emdash-request": "1" },
        body: JSON.stringify({
          title: "Built in the Browser",
          tagline: "EmDash, compiled and served by a tab",
          includeContent: true,
        }),
      });
      const j = await r.json();
      if (!r.ok) return `HTTP ${r.status} ${JSON.stringify(j)}`;
      if (j.data?.seedComplete) return "ok";
    }
    return "seed did not complete";
  });
  expect(seeded).toBe("ok");

  const site = await context.newPage();
  const pending = new Map<string, number>();
  site.on("request", (r) => pending.set(r.url(), Date.now()));
  site.on("requestfinished", (r) => pending.delete(r.url()));
  site.on(
    "requestfailed",
    (r) => (
      pending.delete(r.url()), console.log(`[site failed] ${r.url()} ${r.failure()?.errorText}`)
    ),
  );
  const t0 = Date.now();
  const res = await site.goto("/", { waitUntil: "domcontentloaded", timeout: 120_000 });
  console.log(`[site] GET / ${res?.status()} in ${Date.now() - t0} ms`);
  await site
    .waitForLoadState("load", { timeout: 20_000 })
    .catch(() => console.log(`[site] still loading: ${[...pending.keys()].join(" ")}`));
  await expect(site.getByText("Built in the Browser").first()).toBeVisible({ timeout: 60_000 });
  await shot(site, "02-site-home", true);
  await site.goto("/posts", { waitUntil: "domcontentloaded" });
  await shot(site, "03-site-posts", true);
  const first = site.locator("main a[href^='/posts/']").first();
  const href = await first.getAttribute("href");
  await site.goto(href as string, { waitUntil: "domcontentloaded" });
  await shot(site, "04-site-post", true);
  // The admin: a React island (client:only), hydrated from the client build.
  await site.goto("/_emdash/admin", { waitUntil: "domcontentloaded" });
  await site
    .getByRole("heading", { name: /Set up your site|Sign in|Dashboard|Welcome/ })
    .first()
    .waitFor({ timeout: 90_000 });
  await site.waitForTimeout(1_000);
  await shot(site, "05-admin");

  // The static export, downloaded as a ZIP and served from disk by a plain file server.
  const download = host.waitForEvent("download");
  const exported: string[] = await host.evaluate(() => (window as any).__exportSite());
  console.log(`exported ${exported.length} files: ${exported.slice(0, 20).join(" ")}`);
  expect(exported).toContain("index.html");
  const dir = join(import.meta.dirname, "../../test-results/emdash-export");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "site.zip");
  await (await download).saveAs(zipPath);
  execFileSync("python3", ["-m", "zipfile", "-e", zipPath, join(dir, "site")]);
  const port = 5280 + Math.floor(Math.random() * 100);
  const server = (await import("node:child_process")).spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", join(dir, "site")],
    { stdio: "ignore" },
  );
  try {
    await new Promise((r) => setTimeout(r, 800));
    const browser = context.browser()!;
    const plain = await browser.newContext({ viewport: { width: 1280, height: 860 } }); // no ServiceWorker, no cellb
    const page = await plain.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.getByText("Built in the Browser").first()).toBeVisible();
    await shot(page, "06-exported-home", true);
    await page.goto(`http://127.0.0.1:${port}${href}`);
    await shot(page, "07-exported-post", true);
    writeFileSync(join(dir, "files.txt"), exported.join("\n"));
    await plain.close();
  } finally {
    server.kill();
  }

  // With the package store: a rebuild in the same browser finds every package in it (the lock).
  if (process.env.EMDASH_STORE) {
    const cold = Number(await host.evaluate(() => document.body.dataset.buildMs));
    await host.reload();
    await host.waitForFunction(
      () => document.body.dataset.ready === "true" || document.body.dataset.error,
      null,
      { timeout: 600_000, polling: 2000 },
    );
    const warm = Number(await host.evaluate(() => document.body.dataset.buildMs));
    const text = (await host.locator("#log").textContent()) ?? "";
    console.log(
      `build: cold ${cold} ms, warm ${warm} ms; ${text
        .split("\n")
        .filter((l) => /package cache/.test(l))
        .join(" | ")}`,
    );
    expect(text).toContain("from the last build's lock");
    await shot(host, "08-host-rebuild-log");
  }
});
