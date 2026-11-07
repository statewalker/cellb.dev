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
        if (path === "/set-cookies") {
          const headers = new Headers();
          headers.append("Set-Cookie", "a=1; Path=/");
          headers.append("Set-Cookie", "b=2; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT");
          return new Response("set both", { headers });
        }
        if (path === "/clear-cookie")
          return new Response("cleared", { headers: { "Set-Cookie": "flavour=; Max-Age=0; Path=/" } });
        if (path === "/path") return new Response(u.pathname);
        if (path.startsWith("/tabs/")) return new Response("root " + ${JSON.stringify(tag)} + ": " + path + u.search);
        if (path === "/ws-headers" && req.headers.get("upgrade") === "websocket") {
          const seen = [...req.headers].filter(([k]) => k.startsWith("x-")).map(([k, v]) => k + "=" + v);
          const [client, server] = Object.values(new WebSocketPair());
          server.accept();
          server.addEventListener("message", () => server.send(seen.sort().join(";") || "(none)"));
          return new Response(null, { status: 101, webSocket: client });
        }
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

async function openTab(page: Page, job: object, query = "") {
  await page.goto(`/tabs/index.html${query}`);
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
  // Several Set-Cookie values in one response (one with an Expires, which has a comma), and a
  // deletion.
  expect((await request(page, "/set-cookies")).body).toBe("set both");
  await expect.poll(() => page.evaluate(() => document.cookie)).toMatch(/(^|; )b=2(;|$)/);
  expect(await page.evaluate(() => document.cookie)).toMatch(/(^|; )a=1(;|$)/);
  // The Expires survived the trip (its comma did not split the value): b is not a session cookie.
  // (Chromium caps a cookie's lifetime at 400 days, so it expires then, not in 2037.)
  const expires = await page.evaluate(
    async () => (await (globalThis as any).cookieStore.get("b"))?.expires,
  );
  expect(expires).toBeGreaterThan(Date.now() + 30 * 86_400_000);
  expect((await request(page, "/clear-cookie")).body).toBe("cleared");
  await expect.poll(() => page.evaluate(() => document.cookie)).not.toContain("flavour=");
  const sent = (await request(page, "/cookie")).body;
  expect([sent.includes("a=1"), sent.includes("b=2"), sent.includes("flavour")]).toEqual([
    true,
    true,
    false,
  ]);
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
    "x-cellb-method": "anything",
    "x-cellb-proto": "https:",
    "x-cellb-ws": "w1",
    "x-cellb-upgrade": "websocket",
    "x-cellb-ws-protocol": "v1",
    "x-cellb-cookie": "forged=1",
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
  // Each room twice: whichever shards take the page's sockets (round robin or always the same),
  // at least one of the four reaches its room from the other shard.
  for (const room of [roomIn(0), roomIn(0), roomIn(1), roomIn(1)])
    expect(await socket(`/room?name=${room}`, "hello")).toBe(`room ${room}: hello`);
  // A page cannot put the router's control headers on a socket either.
  const forged: [string, string][] = [
    ["x-cellb", "fetch"],
    ["x-cellb-binding", "ROOM"],
    ["x-cellb-target", `name:${roomIn(1)}`],
    ["x-cellb-shard", "1"],
    ["x-cellb-method", "anything"],
    ["x-cellb-proto", "https:"],
    ["x-cellb-ws", "w1"],
    ["x-cellb-upgrade", "websocket"],
    ["x-cellb-cookie", "forged=1"],
    ["x-test", "kept"],
  ];
  expect(
    await page.evaluate(([p, m, h]) => (window as any).__socket(p, m, undefined, h), [
      "/ws-headers",
      "?",
      forged,
    ] as const),
  ).not.toMatch(/x-cellb/);
  // Nor through webrun-http-browser's own socket call, with the names in another letter case
  // (the upgrade's Headers lowercase them only after the router filtered them).
  const shouted = forged.map(([k, v]) => [k.toUpperCase(), v] as [string, string]);
  expect(
    await page.evaluate(([p, m, h]) => (window as any).__socket(p, m, undefined, h, "package"), [
      "/ws-headers",
      "?",
      shouted,
    ] as const),
  ).not.toMatch(/x-cellb/);
});

test("stripBase: the Worker sees the path under the project's base", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  const name = `strip-${Date.now().toString(36)}`;
  await openTab(page, { name, shards: 1, ...project }, "?strip=1");
  expect((await request(page, "/path")).body).toBe("/path");
});

test("stripBase cuts the project's name as the URL spells it", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  // `@` stays as it is in a URL's path, and `encodeURIComponent` would escape it.
  const name = `strip@${Date.now().toString(36)}`;
  await openTab(page, { name, shards: 1, ...project }, "?strip=1");
  expect((await request(page, "/path", undefined, name)).body).toBe("/path");
});

test("without stripBase the Worker sees the URL the page asked for", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  const name = `full-${Date.now().toString(36)}`;
  await openTab(page, { name, shards: 1, ...project });
  expect((await request(page, "/path")).body).toBe(`/tabs/app/${name}/path`);
});

test("a root project: the origin's other paths go to it unchanged, passthrough paths do not", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = await routerProject("one");
  const name = `root-${Date.now().toString(36)}`;
  await openTab(page, { name, shards: 1, ...project }, `?root=${name}&host=/tabs/host.html`);
  expect(await request(page, "/tabs/some/page?q=1")).toEqual({
    status: 200,
    body: "root one: /tabs/some/page?q=1",
  });
  expect((await request(page, "/tabs/host.html")).body).toContain("host page");
  // A navigation while a tab runs the project: served, not sent to the host page.
  await page.goto("/tabs/landing");
  expect(new URL(page.url()).pathname).toBe("/tabs/landing");
  expect(await page.textContent("body")).toBe("root one: /tabs/landing");
});

test("a root project: a navigation no tab serves goes to the host page, with where it was going", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const name = `nobody-${Date.now().toString(36)}`;
  await page.goto(`/tabs/index.html?root=${name}&host=/tabs/host.html&wait=300`);
  await page.waitForFunction(
    () => document.body.dataset.ready === "true" || document.body.dataset.error,
  );
  expect(await page.evaluate(() => document.body.dataset.error ?? null)).toBeNull();
  await page.goto("/tabs/somewhere?x=1");
  expect(new URL(page.url()).pathname).toBe("/tabs/host.html");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/tabs/somewhere?x=1");
  expect(await page.textContent("body")).toContain("host page");
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
