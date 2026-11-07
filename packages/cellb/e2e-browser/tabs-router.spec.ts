import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { idFromName, namespaceKey } from "../src/core/id.ts";
import { shardOf } from "../src/core/shard.ts";
import { bundleWorkerForBrowser } from "../src/node.ts";

// What the router of a project shared by tabs (installProjectRouter) does besides balancing
// shards (tabs.spec.ts): the page's cookies in and the Worker's out, no control headers from a
// page, sockets from the page and between shards, and several projects on one ServiceWorker.

/** A project: a Worker that echoes what it gets, and a Room object that answers sockets. */
async function routerProject(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), "tabs-router-"));
  writeFileSync(
    join(dir, "index.js"),
    `import { DurableObject } from "cloudflare:workers";
    export class Room extends DurableObject {
      async fetch(req) {
        const name = new URL(req.url).searchParams.get("name");
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.addEventListener("message", (e) => server.send("room " + name + ": " + e.data));
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    export default {
      async fetch(req, env) {
        const u = new URL(req.url);
        const path = u.pathname.replace(/^.*\\/tabs\\/app\\/[^/]+/, "");
        if (path === "/set-cookie")
          return new Response("set", { headers: { "Set-Cookie": "flavour=" + u.searchParams.get("v") + "; Path=/" } });
        if (path === "/cookie") return new Response(req.headers.get("cookie") ?? "(none)");
        if (path === "/headers") {
          const seen = [...req.headers].filter(([k]) => k.startsWith("x-")).map(([k, v]) => k + "=" + v);
          return new Response(seen.sort().join(";") || "(none)");
        }
        if (path === "/who") return new Response(${JSON.stringify(tag)});
        if (path === "/echo" && req.headers.get("upgrade") === "websocket") {
          const [client, server] = Object.values(new WebSocketPair());
          server.accept();
          server.addEventListener("message", (e) => server.send("echo: " + e.data));
          return new Response(null, { status: 101, webSocket: client });
        }
        if (path === "/room") return env.ROOM.getByName(u.searchParams.get("name")).fetch(req);
        return new Response("not found", { status: 404 });
      },
    };`,
  );
  return {
    config: {
      name: "router",
      main: "index.js",
      durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    },
    code: await bundleWorkerForBrowser(join(dir, "index.js")),
  };
}

async function openTab(page: Page, job: object) {
  await page.goto("/tabs/");
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.evaluate((j) => (window as any).__join(j), job);
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.owned ?? ""))
    .toBe(Array.from({ length: (job as { shards: number }).shards }, (_, i) => i).join(","));
}

const request = (page: Page, path: string, init: RequestInit = {}, project?: string) =>
  page.evaluate(([p, i, n]) => (window as any).__request(p, i, n), [path, init, project] as const);

test("the page's cookies reach the Worker, and the Worker's Set-Cookie reaches the page", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the router's cookies need the Cookie Store API");
  test.setTimeout(120_000);
  const project = await routerProject("one");
  await openTab(page, { name: `cookies-${Date.now().toString(36)}`, shards: 2, ...project });
  expect(await request(page, "/set-cookie?v=mint")).toEqual({ status: 200, body: "set" });
  await expect.poll(() => page.evaluate(() => document.cookie)).toContain("flavour=mint");
  expect((await request(page, "/cookie")).body).toContain("flavour=mint");
});

test("a page cannot send the router's control headers to the Worker", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  await openTab(page, { name: `headers-${Date.now().toString(36)}`, shards: 2, ...project });
  const forged = {
    "x-cellb": "fetch",
    "x-cellb-binding": "ROOM",
    "x-cellb-target": "name:lobby",
    "x-cellb-shard": "1",
    "x-test": "kept",
  };
  // The request still reaches the Worker's own fetch (not the Room directly), without them.
  expect(await request(page, "/headers", { headers: forged })).toEqual({
    status: 200,
    body: "x-test=kept",
  });
});

test("sockets: from the page to the Worker, and from the Worker to a Room in another shard", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  await openTab(page, { name: `sockets-${Date.now().toString(36)}`, shards: 2, ...project });
  const socket = (path: string, message: string) =>
    page.evaluate(([p, m]) => (window as any).__socket(p, m), [path, message] as const);
  expect(await socket("/echo", "hi")).toBe("echo: hi");
  // Rooms in each shard: whichever shard takes the page's socket, one of them is elsewhere.
  const ns = namespaceKey("router", "Room");
  const roomIn = (s: number) =>
    Array.from({ length: 50 }, (_, i) => `r${i}`).find(
      (n) => shardOf(idFromName(ns, n).toString(), 2) === s,
    )!;
  for (const room of [roomIn(0), roomIn(1)])
    expect(await socket(`/room?name=${room}`, "hello")).toBe(`room ${room}: hello`);
});

test("two projects on one ServiceWorker each reach their own Worker", async ({ page }) => {
  test.setTimeout(120_000);
  const one = await routerProject("one");
  const two = await routerProject("two");
  const stamp = Date.now().toString(36);
  await openTab(page, { name: `one-${stamp}`, shards: 2, ...one });
  await page.evaluate((j) => (window as any).__joinAnother(j), {
    name: `two-${stamp}`,
    shards: 1,
    ...two,
  });
  await expect.poll(async () => (await request(page, "/who", {}, `two-${stamp}`)).body).toBe("two");
  expect((await request(page, "/who", {}, `one-${stamp}`)).body).toBe("one");
});
