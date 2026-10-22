import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../../conformance/browser-bundle.ts";
import {
  alignBrowserDifferences,
  alignDocumentedDifferences,
  scenarios,
} from "../../conformance/scenarios.ts";
import { startReferenceServer } from "../../test/ws-reference-server.ts";

// The same 25 projects as test/p09 (celld's examples and ours), run on webrun-cells INSIDE
// Chromium — Dedicated Worker, SQLite on OPFS, browser fetch/WebSocket/Request — and compared
// with the transcripts and logs recorded from the real celld 0.6.2.
const golden = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../conformance/golden/${name}.json`), "utf8"),
  );

/** Projects that cannot run in a browser realm (documented in note 18). */
const browserGaps: Record<string, string> = {};

for (const name of Object.keys(scenarios)) {
  const s = scenarios[name];
  const wait =
    (s.settleMs ?? 1500) + s.steps.reduce((n, st) => n + ("waitMs" in st ? st.waitMs : 0), 0);
  test(name, async ({ page }) => {
    test.skip(!!s.knownGap, `known gap: ${s.knownGap}`);
    test.skip(!!browserGaps[name], browserGaps[name]);
    test.setTimeout(wait + 60_000);
    const ref = s.wsServer ? await startReferenceServer() : undefined;
    try {
      const project = await bundleProjectForBrowser(name);
      await page.goto("/projects/");
      await page.waitForFunction(() => document.body.dataset.ready === "true");
      const r = await page.evaluate((job) => (window as any).__runProject(job), {
        project,
        scenario: name,
        wsServer: ref ? `ws://127.0.0.1:${ref.port}` : undefined,
      });
      expect(r.ok, r.error).toBe(true);
      const expected = golden(name);
      const aligned = alignDocumentedDifferences(r.transcript, expected.transcript);
      expect(alignBrowserDifferences(aligned, expected.transcript)).toEqual(expected.transcript);
      if (expected.logs) expect(r.logs).toEqual(expected.logs);
    } finally {
      await ref?.close();
    }
  });
}
