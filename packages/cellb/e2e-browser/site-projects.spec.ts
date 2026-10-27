import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { projectForSite } from "../conformance/browser-bundle.ts";
import {
  alignBrowserDifferences,
  alignDocumentedDifferences,
  goldenDir,
  scenarios,
} from "../conformance/scenarios.ts";
import { startReferenceServer } from "../test/ws-reference-server.ts";

// The celld projects served by an IN-BROWSER HTTP SERVER: the page mounts a
// webrun-site-builder handler (sources compiled to ESM by webrun-modules) with
// webrun-site-host in the ServiceWorker; a Dedicated Worker `import()`s the code from those
// URLs and runs it on cellb; the Worker Loader uploads loaded code to the same server.
// Results must equal the transcripts and logs recorded from the real celld 0.6.2.
const golden = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, `../conformance/${goldenDir(name)}/${name}.json`),
      "utf8",
    ),
  );

for (const name of Object.keys(scenarios)) {
  const s = scenarios[name];
  const wait =
    (s.settleMs ?? 1500) + s.steps.reduce((n, st) => n + ("waitMs" in st ? st.waitMs : 0), 0);
  test(name, async ({ page }) => {
    test.skip(!!s.knownGap, `known gap: ${s.knownGap}`);
    test.setTimeout(wait + 60_000);
    const ref = s.wsServer ? await startReferenceServer() : undefined;
    try {
      await page.goto("/site-projects/");
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      const r = await page.evaluate((job) => (window as any).__runOnSite(job), {
        ...projectForSite(name),
        scenario: name,
        wsServer: ref ? `ws://127.0.0.1:${ref.port}` : undefined,
      });
      expect(r.ok, r.error).toBe(true);
      if (r.moduleUrl)
        expect(r.moduleUrl).toMatch(/^http:\/\/localhost:\d+\/site-[^/]+\/modules\/~\//);
      const expected = golden(name);
      const aligned = alignDocumentedDifferences(r.transcript, expected.transcript);
      expect(alignBrowserDifferences(aligned, expected.transcript)).toEqual(expected.transcript);
      if (expected.logs) expect(r.logs).toEqual(expected.logs);
    } finally {
      await ref?.close();
    }
  });
}

// A project on a site gets its own `env` and `exports` from `cloudflare:workers` (at load too)
// and `cloudflare:email`. A Worker it loads into an isolate gets its own; one loaded into the
// project's realm shares the realm's module registry, and gets empty ones.
const SITE_ENV_WORKER = `
import { DurableObject, env, exports } from "cloudflare:workers";
import * as cf from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
const atLoad = env.GREETING;
export class Box extends DurableObject { hi() { return "box " + env.GREETING; } }
export default {
  async fetch(req, e) {
    if (new URL(req.url).pathname === "/loaded") {
      const w = e.LOADER.get("w1", () => ({
        compatibilityDate: "2026-10-01",
        mainModule: "w.js",
        modules: {
          "w.js": 'import { WorkerEntrypoint, env, exports } from "cloudflare:workers";' +
            "export class Echo extends WorkerEntrypoint {}" +
            "export default { fetch() { return Response.json({ env: Object.keys(env), exports: Object.keys(exports) }); } };",
        },
        env: { NAME: "w1" },
      }));
      return w.getEntrypoint().fetch(req);
    }
    let email;
    try { new EmailMessage("a@x", "b@x", "raw"); } catch (err) { email = err.message; }
    return Response.json({
      atLoad,
      now: env.GREETING,
      namespace: cf.env.GREETING,
      viaExports: await exports.Box.getByName("a").hi(),
      email,
    });
  },
};
`;
for (const noIsolate of [false, true])
  test(`a site's project has its own env and exports; loaded Workers ${noIsolate ? "in its realm do not" : "in isolates too"}`, async ({
    page,
  }) => {
    const config = {
      name: "site-env",
      main: "index.js",
      vars: { GREETING: "hi" },
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings: [{ name: "BOX", class_name: "Box" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Box"] }],
    };
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    await page.goto("/site-projects/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const r = await page.evaluate((job) => (window as any).__runOnSite(job), {
      name: "site-env",
      scenario: "",
      config,
      files: [
        ["/index.js", b64(SITE_ENV_WORKER)],
        ["/wrangler.json", b64(JSON.stringify(config))],
      ],
      assets: [],
      paths: ["/", "/loaded"],
      noIsolate,
    });
    expect(r.ok, r.error).toBe(true);
    expect(JSON.parse(r.answers[0])).toEqual({
      atLoad: "hi",
      now: "hi",
      namespace: "hi",
      viaExports: "box hi",
      email: "cloudflare:email is not supported by cellb",
    });
    expect(JSON.parse(r.answers[1])).toEqual(
      noIsolate ? { env: [], exports: [] } : { env: ["NAME"], exports: ["Echo"] },
    );
  });
