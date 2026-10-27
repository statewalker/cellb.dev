import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleProjectForBrowser } from "../conformance/browser-bundle.ts";
import {
  alignBrowserDifferences,
  alignDocumentedDifferences,
  goldenDir,
  LOADED_IN_REALM,
  scenarios,
} from "../conformance/scenarios.ts";
import { startReferenceServer } from "../test/ws-reference-server.ts";

// The same 25 projects as test/p09 (celld's examples and ours), run on cellb INSIDE
// a browser — Dedicated Worker, SQLite on OPFS, browser fetch/WebSocket/Request — and compared
// with the transcripts and logs recorded from the real celld 0.6.2.
const golden = (name: string) =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, `../conformance/${goldenDir(name)}/${name}.json`),
      "utf8",
    ),
  );

// Each scenario with loaded Workers in isolates; LOADED_IN_REALM also in the project's realm.
const runs = [
  ...Object.keys(scenarios).map((name) => ({ name, noIsolate: false })),
  ...LOADED_IN_REALM.map((name) => ({ name, noIsolate: true })),
];
for (const { name, noIsolate } of runs) {
  const s = scenarios[name];
  const wait =
    (s.settleMs ?? 1500) + s.steps.reduce((n, st) => n + ("waitMs" in st ? st.waitMs : 0), 0);
  test(noIsolate ? `${name} — loaded in the project's realm` : name, async ({ page }) => {
    test.skip(!!s.knownGap, `known gap: ${s.knownGap}`);
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
        noIsolate,
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
