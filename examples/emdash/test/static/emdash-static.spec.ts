import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { gradientPng } from "./png.ts";

// The static build (dist/static: `pnpm build:static`) served by Python's http.server, a plain
// file server. Once the host tab has loaded the files, the file server is STOPPED: EmDash's
// setup, its admin, the passkey, a post with an image and the public site are all answered in
// the browser. The server comes back only to reload the host page at the end, after which the
// site is read back from OPFS. Screenshots of each step go to screenshots/static/.
const dir = join(import.meta.dirname, "../../dist/static");
const shots = join(import.meta.dirname, "../../screenshots/static");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage });

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

/** `python3 -m http.server` on `port`, serving dist/static; resolves once it answers. */
async function fileServer(port: number): Promise<ChildProcess & { requests: string[] }> {
  const proc = spawn(
    "python3",
    ["-u", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  ) as ChildProcess & { requests: string[] };
  proc.requests = [];
  proc.stderr!.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      const m = /"(GET|HEAD|POST|PUT|DELETE) ([^ ]+)/.exec(line);
      if (m) proc.requests.push(`${m[1]} ${m[2]}`);
    }
  });
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return proc;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the file server did not start");
}
const stop = (p: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve(); // already stopped
    p.once("exit", () => resolve());
    p.kill();
  });

async function openHost(context: BrowserContext, origin: string): Promise<Page> {
  const host = await context.newPage();
  // The first visit gets the static index, which sends it to /__cellb/; later ones, with no tab
  // running the site, are sent there by the ServiceWorker (/__cellb/?next=/).
  await host.goto(`${origin}/`);
  await host.waitForURL(/\/__cellb\/(\?next=.*)?$/);
  await host.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
    null,
    { timeout: 120_000 },
  );
  expect(await host.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  return host;
}

test("the static build: EmDash in the browser, with the file server stopped", async ({
  context,
}) => {
  if (!existsSync(join(dir, "cellb-sw.js"))) throw new Error("run `pnpm build:static` first");
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  let server = await fileServer(port);
  try {
    const host = await openHost(context, origin);
    await shot(host, "01-host-tab");

    // From here on there is no server at all.
    const served = [...server.requests];
    await stop(server);
    expect(
      await fetch(`${origin}/__cellb/`).then(
        () => "up",
        () => "down",
      ),
    ).toBe("down");

    const site = await context.newPage();
    const t0 = Date.now();
    const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
    site.on(
      "console",
      (m) => m.type() === "error" && log(`site console: ${m.text().slice(0, 200)}`),
    );
    site.on("framenavigated", (f) => f === site.mainFrame() && log(`nav ${f.url()}`));
    host.on(
      "console",
      (m) =>
        (m.type() === "error" || m.type() === "warning") &&
        log(`host console: ${m.text().slice(0, 200)}`),
    );
    const cdp = await context.newCDPSession(site);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    // The setup wizard: the template's seed goes into D1, then the account and its passkey.
    await site.goto(`${origin}/_emdash/admin`);
    await expect(site.getByRole("heading", { name: "Set up your site" })).toBeVisible({
      timeout: 60_000,
    });
    await site.getByLabel("Site Title").fill("Cells in the Browser");
    await site.getByLabel("Tagline").fill("An EmDash site served from a browser tab");
    await shot(site, "02-setup-site");
    await site.getByRole("button", { name: /Continue/ }).click();
    await expect(site.getByRole("heading", { name: "Create your account" })).toBeVisible({
      timeout: 120_000,
    });
    await site.getByLabel("Your Email").fill("mikhail@example.com");
    await site.getByLabel("Your Name").fill("Mikhail");
    await site.getByRole("button", { name: /Continue/ }).click();
    await site.getByRole("button", { name: "Create passkey" }).click();
    await expect(site.getByText("Passkey created")).toBeVisible({ timeout: 60_000 });
    await shot(site, "03-passkey-created");
    log("passkey done");

    // A post with a featured image: the image goes to R2, the post to D1.
    await site.goto(`${origin}/_emdash/admin/content/posts/new`, { timeout: 60_000 });
    log("editor loaded");
    const welcome = site.getByRole("button", { name: "Get Started" });
    await welcome.click({ timeout: 30_000 }).catch(() => {}); // the first sign-in's welcome
    log("welcome handled");
    await site.getByLabel("Title").fill("Hello from cellb", { timeout: 30_000 });
    log("title");
    await site.locator("[contenteditable=true]").first().click();
    log("editor clicked");
    await site.keyboard.type(
      "This post was written in EmDash's admin and is stored in SQLite on OPFS. The whole CMS " +
        "runs on cellb inside the tab that opened this site; the file server that sent its " +
        "files was stopped before this post was written.",
    );
    log("typed");
    // The featured image: EmDash's media dialog, "Upload files", then the uploaded file.
    await site.getByText("browse", { exact: true }).first().click();
    const dialog = site.getByRole("dialog");
    const chooser = site.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: /Upload files/ }).click();
    await (await chooser).setFiles({
      name: "cells.png",
      mimeType: "image/png",
      buffer: gradientPng(1200, 630),
    });
    log("uploading");
    await dialog.getByText("cells.png").first().click({ timeout: 60_000 });
    await site.waitForTimeout(500);
    await shot(site, "04-media-library");
    await dialog.getByRole("button", { name: "Select", exact: true }).click();
    log("image chosen");
    await site.waitForTimeout(3_000);
    await site.getByRole("button", { name: "Save" }).click({ timeout: 30_000 });
    log("save clicked");
    await expect(site.getByRole("button", { name: /Publish now/ })).toBeEnabled({
      timeout: 60_000,
    });
    log("saved");
    await site.getByRole("button", { name: /Publish now/ }).click({ timeout: 30_000 });
    await shot(site, "05-publish-confirm");
    await site
      .getByRole("alertdialog")
      .or(site.getByRole("dialog"))
      .getByRole("button", { name: /Publish now/ })
      .click();
    await expect(site.getByText("Draft version")).toBeHidden({ timeout: 60_000 });
    log("published");
    await site.waitForTimeout(1_500);
    await shot(site, "06-post-published");

    // The public site, rendered by the same Worker.
    const pages: [string, string][] = [
      ["/", "07-site-home"],
      ["/posts/hello-from-cellb", "08-site-post"],
      ["/posts", "09-site-posts"],
    ];
    for (const [path, name] of pages) {
      await site.goto(`${origin}${path}`);
      await expect(site.getByText("Hello from cellb").first()).toBeVisible({ timeout: 30_000 });
      await site.waitForTimeout(1_500); // images
      await shot(site, name, true);
      log(`shot ${name}`);
    }
    // The uploaded image, read back from R2 on the post's page.
    await site.goto(`${origin}/posts/hello-from-cellb`);
    const img = site.locator("main img").first();
    await expect(img).toBeVisible();
    log(`image ${await img.getAttribute("src")}`);
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    log("image read back");

    // Nothing reached a server, and nothing went to the shard's error log.
    expect(server.requests.length - served.length).toBe(0);
    expect(await host.evaluate(() => (window as any).__problems())).toEqual([]);
    log("no requests, no problems");

    // The file server is back for the host page only: a new host tab, the site read from OPFS.
    server = await fileServer(port);
    await site.close();
    await host.close();
    log("host closed");
    const host2 = await openHost(context, origin);
    log(`host reopened at ${host2.url()}`);
    await shot(host2, "10-host-tab-after-restart");
    const again = await context.newPage();
    await again.goto(`${origin}/posts/hello-from-cellb`);
    await expect(again.getByRole("heading", { name: "Hello from cellb" })).toBeVisible({
      timeout: 60_000,
    });
    await again.waitForTimeout(1_500);
    await shot(again, "11-site-post-after-restart", true);
    log("after restart");
    const appRequests = server.requests.filter((r) => !/ \/(__cellb\/|cellb-sw\.js|$)/.test(r));
    expect(appRequests).toEqual([]); // the file server only ever sent the host's own files
  } catch (err) {
    for (const [i, p] of context.pages().entries())
      await p.screenshot({ path: join(shots, `failed-${i}.png`), timeout: 10_000 }).catch(() => {});
    throw err;
  } finally {
    await stop(server).catch(() => {});
  }
});
