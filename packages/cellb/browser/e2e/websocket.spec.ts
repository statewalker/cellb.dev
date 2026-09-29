import { expect, type Page, test } from "@playwright/test";

const open = async (page: Page) => {
  await page.goto("/sharded/");
  await page.waitForFunction(
    () => document.body.dataset.owned === "0,1" || !!document.body.dataset.error,
    null,
    { timeout: 30_000 },
  );
  expect((await page.evaluate(() => document.body.dataset.error)) ?? "").toBe("");
};

test("page WebSockets reach a Room DO through SW → shard (local and cross-shard) and broadcast", async ({
  page,
}) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const WS = (window as any).__CellsWebSocket;
    const url = `${location.origin.replace("http", "ws")}/sharded/cells/room/r${Date.now()}`;
    const next = (ws: any, type: string) =>
      new Promise<any>((res) => ws.addEventListener(type, res, { once: true }));
    // Ingress alternates between the two shards: one of these sockets crosses shards.
    const a = new WS(url);
    const b = new WS(url);
    await Promise.all([next(a, "open"), next(b, "open")]);
    const where = next(a, "message");
    a.send("where?");
    const hostedBy = (await where).data;
    const got = Promise.all([next(a, "message"), next(b, "message")]);
    b.send("hello");
    const broadcast = (await got).map((e) => e.data);
    const closed = next(a, "close");
    a.send("bye");
    const c = await closed;
    return {
      hostedBy,
      broadcast,
      close: [c.code, c.reason, c.wasClean],
      native: a instanceof WebSocket,
    };
  });
  expect(r.hostedBy).toMatch(/^shard:[01]$/);
  expect(r.broadcast).toEqual(["hello", "hello"]);
  expect(r.close).toEqual([4000, "bye bye", true]);
  expect(r.native).toBe(false);
});

test("UNMODIFIED user code served by webrun-modules in the SW: browser `new WebSocket` ↔ Cloudflare `WebSocketPair`", async ({
  page,
}) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const client = await (window as any).__importUser("chat-client.ts");
    const url = `${location.origin.replace("http", "ws")}/sharded/cells/lobby/l${Date.now()}`;
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await client.say(url, `hi ${i}`)); // both ingress shards
    const src = await (await fetch("/sharded/modules/~/chat-client.ts")).text();
    return { results, rewritten: src.includes("~deps") };
  });
  expect(r.rewritten).toBe(true);
  expect(r.results).toEqual([
    { reply: "lobby:hi 0", protocol: "", native: false },
    { reply: "lobby:hi 1", protocol: "", native: false },
  ]);
});

test("a socket held by another tab's shard closes with 1006 when that tab dies", async ({
  context,
}) => {
  const owner = await context.newPage();
  await open(owner);
  const user = await context.newPage();
  await user.goto("/sharded/");
  await user.waitForFunction(() => document.body.dataset.ready === "true");
  await user.evaluate(async () => {
    const WS = (window as any).__CellsWebSocket;
    const ws = new WS(`${location.origin.replace("http", "ws")}/sharded/cells/room/o${Date.now()}`);
    (window as any).__closed = new Promise((res) =>
      ws.addEventListener("close", (e: any) => res([e.code, e.wasClean])),
    );
    await new Promise((res) => ws.addEventListener("open", res, { once: true }));
  });
  await owner.close();
  const closed = await user.evaluate(() =>
    Promise.race([
      (window as any).__closed,
      new Promise((r) => setTimeout(() => r("still open"), 5_000)),
    ]),
  );
  expect(closed).toEqual([1006, false]);
});
