import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { projectForSite } from "../../conformance/browser-bundle.ts";
import { alignDocumentedDifferences, scenarios } from "../../conformance/scenarios.ts";
import { startReferenceServer } from "../../test/ws-reference-server.ts";

// The celld projects served by an IN-BROWSER HTTP SERVER: the page mounts a
// webrun-site-builder handler (sources compiled to ESM by webrun-modules) with
// webrun-site-host in the ServiceWorker; a Dedicated Worker `import()`s the code from those
// URLs and runs it on webrun-cells; the Worker Loader uploads loaded code to the same server.
// Results must equal the transcripts and logs recorded from the real celld 0.6.2.
const golden = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../conformance/golden/${name}.json`), "utf8"),
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
      expect(alignDocumentedDifferences(r.transcript, expected.transcript)).toEqual(
        expected.transcript,
      );
      if (expected.logs) expect(r.logs).toEqual(expected.logs);
    } finally {
      await ref?.close();
    }
  });
}
