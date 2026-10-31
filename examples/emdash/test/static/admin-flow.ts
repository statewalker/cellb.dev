import { type BrowserContext, expect, type Page } from "@playwright/test";
import { gradientPng } from "./png.ts";

/** The post the flow writes: its title and its URL on the site. */
export const POST_TITLE = "Hello from cellb";
export const POST_PATH = "/posts/hello-from-cellb";

/**
 * EmDash's whole first-use flow in its admin, as a person goes through it: the setup wizard
 * (the template's seed into D1), an account with a passkey (a virtual authenticator), a post
 * with a featured image (uploaded to R2), published; then the public pages and the image read
 * back. Used by the static build's spec and by the in-browser build's.
 */
export async function adminFlow(
  context: BrowserContext,
  site: Page,
  origin: string,
  o: {
    log: (m: string) => void;
    shot: (page: Page, name: string, fullPage?: boolean) => Promise<unknown>;
    title: string;
    tagline: string;
    body: string;
  },
): Promise<void> {
  const { log, shot } = o;
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
  await site.getByLabel("Site Title").fill(o.title);
  await site.getByLabel("Tagline").fill(o.tagline);
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
  await site.getByLabel("Title").fill(POST_TITLE, { timeout: 30_000 });
  log("title");
  await site.locator("[contenteditable=true]").first().click();
  log("editor clicked");
  await site.keyboard.type(o.body);
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
    [POST_PATH, "08-site-post"],
    ["/posts", "09-site-posts"],
  ];
  for (const [path, name] of pages) {
    await site.goto(`${origin}${path}`);
    await expect(site.getByText(POST_TITLE).first()).toBeVisible({ timeout: 30_000 });
    await site.waitForTimeout(1_500); // images
    await shot(site, name, true);
    log(`shot ${name}`);
  }
  // The uploaded image, read back from R2 on the post's page.
  await site.goto(`${origin}${POST_PATH}`);
  const img = site.locator("main img").first();
  await expect(img).toBeVisible();
  log(`image ${await img.getAttribute("src")}`);
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  log("image read back");
}
