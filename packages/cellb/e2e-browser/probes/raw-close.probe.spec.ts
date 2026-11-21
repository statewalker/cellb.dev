import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { rawChromium } from "../raw-chromium.ts";

// rawChromium's close() removes its profile every time (statewalker/cellb.dev#195). Killing only
// Chromium's main process left helpers writing to the profile, and its removal failed with
// ENOTEMPTY in about 1 run in 7 of this loop. Opens the tabs page (ServiceWorker, OPFS), closes.
//   RAW_CLOSE_RUNS=20 pnpm probes:browser raw-close
test("rawChromium close() removes its profile every time", async ({ baseURL }) => {
  const runs = Number(process.env.RAW_CLOSE_RUNS ?? 20);
  test.setTimeout(runs * 30_000);
  const profiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith("raw-chromium-"));
  const before = new Set(profiles());
  const failures: string[] = [];
  for (let i = 0; i < runs; i++) {
    const browser = await rawChromium();
    const page = await browser.open(`${baseURL}/tabs/`);
    await page.waitFor(
      `() => document.body?.dataset.ready === "true" || !!document.body?.dataset.error`,
    );
    await browser.close().catch((err) => failures.push(`run ${i}: ${(err as Error).message}`));
  }
  expect(failures).toEqual([]);
  expect(profiles().filter((f) => !before.has(f))).toEqual([]); // none left behind
});
