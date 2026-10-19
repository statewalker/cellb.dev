import { expect, type Page, test } from "@playwright/test";
import { cases } from "../../test/ws-conformance.ts";
import { startReferenceServer } from "../../test/ws-reference-server.ts";

// Every case of test/ws-conformance.ts, in Chromium, against:
//   native  — the browser's own WebSocket ⇄ a real `ws` server (the reference behaviour),
//   cells   — webrun-cells sockets: page → ServiceWorker router → shard workers → Room DO
//             (ingress alternates between shards, so rooms are reached locally and cross-shard).
let server: Awaited<ReturnType<typeof startReferenceServer>>;
test.beforeAll(async () => {
  server = await startReferenceServer();
});
test.afterAll(async () => server?.close());

let shared: Page | undefined;
async function sharedPage(browser: import("@playwright/test").Browser): Promise<Page> {
  if (shared && !shared.isClosed()) return shared;
  shared = await browser.newPage();
  await shared.goto("/sharded/");
  await shared.waitForFunction(
    () => document.body.dataset.owned === "0,1" || !!document.body.dataset.error,
    null,
    {
      timeout: 30_000,
    },
  );
  return shared;
}

for (const impl of ["native", "cells"] as const) {
  test.describe(`WebSocket conformance — ${impl}`, () => {
    for (const name of Object.keys(cases)) {
      test(name, async ({ browser }) => {
        const page = await sharedPage(browser);
        const r = await page.evaluate(([i, n, base]) => (window as any).__wsCase(i, n, base), [
          impl,
          name,
          `ws://127.0.0.1:${server.port}`,
        ] as const);
        expect(r, r.error).toEqual({ ok: true });
      });
    }
  });
}
