import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bundleWorkerForBrowser } from "../src/project/browser-bundle.ts";
import { fixtureDir, partyConfig } from "../test/partyserver/fixture.ts";

// The partyserver host project of test/p36 (cloudflare/partykit, unchanged) on cellb INSIDE a
// browser: a party room, partywhen's scheduler, and an extension loaded at run time whose
// partyserver Server runs as a facet in an isolate (a Dedicated Worker of its own).
test("partyserver: room, scheduler and a loaded extension, over HTTP and WebSockets", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const config = await partyConfig();
  const bundle = await bundleWorkerForBrowser(join(fixtureDir, "index.js"), { nodeCompat: true });
  await page.goto("/party/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const party = async (op: object) => {
    const r = await page.evaluate((o) => (window as any).__party(o), op);
    expect(r.ok, r.error).toBe(true);
    return r;
  };
  const get = async (path: string) => JSON.parse((await party({ op: "fetch", path })).text);

  const run = Date.now().toString(36);
  expect((await party({ op: "start", config, bundle, run })).unsupported).toEqual([]);

  // A room: the greeting, then the broadcast of its own message.
  const room = await party({ op: "socket", path: "/parties/room/lobby", send: ["hi"], receive: 2 });
  expect(room.inbox).toEqual([
    JSON.stringify({ room: "lobby", n: 0 }),
    JSON.stringify({ room: "lobby", n: 1, msg: "hi" }),
  ]);

  // partywhen: a delayed task calls the room through an alarm.
  await party({ op: "fetch", path: "/schedule" });
  await expect
    .poll(async () => (await get("/parties/room/lobby")).ticks, { timeout: 15_000 })
    .toBe(1);

  // A loaded extension, as a facet under its own id's name, over HTTP and a WebSocket.
  expect(await get("/ext/notes")).toEqual({ plugin: "facet:notes", activations: 1, requests: 1 });
  const ext = await party({ op: "socket", path: "/ext/notes", send: ["ping"], receive: 2 });
  expect(ext.inbox).toEqual([
    JSON.stringify({ plugin: "facet:notes", hello: true }),
    JSON.stringify({ plugin: "facet:notes", echo: "ping" }),
  ]);

  // A fresh runtime continues from the log: the room's count, the extension's activations.
  await party({ op: "restart" });
  expect(await get("/parties/room/lobby")).toMatchObject({ n: 1, ticks: 1 });
  expect(await get("/ext/notes")).toEqual({ plugin: "facet:notes", activations: 2, requests: 2 });
});
