import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CellsResponse,
  createCellRuntime,
  createWebSocketClass,
  DurableObject,
  WebSocketPair,
} from "../src/index.js";

/** Hibernation-API chat: sockets accepted by ctx, events through handlers, tags. */
class Hub extends DurableObject {
  static closes: unknown[] = [];
  async fetch(req: Request) {
    const room = new URL(req.url).searchParams.get("tag") ?? "all";
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [room]);
    return new CellsResponse(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: any, msg: string) {
    if (msg === "tags?") return ws.send(JSON.stringify(this.ctx.getTags(ws)));
    if (msg === "count?") return ws.send(String(this.ctx.getWebSockets().length));
    const [tag, text] = msg.split(":");
    for (const peer of this.ctx.getWebSockets(tag)) peer.send(`${tag}>${text}`);
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
  }
  async webSocketClose(_ws: any, code: number, reason: string, wasClean: boolean) {
    Hub.closes.push({ code, reason, wasClean });
  }
}

const setup = () => {
  const rt = createCellRuntime({
    worker: {
      Hub,
      default: { fetch: (req: Request, env: any) => env.HUB.getByName("hub").fetch(req) },
    },
    durableObjects: { HUB: { className: "Hub" } },
    openSql: nodeSqliteOpener(),
  });
  const WS = createWebSocketClass((url, p) => rt.connectWebSocket(url, p));
  const open = async (tag: string) => {
    const ws = new WS(`ws://h/?tag=${tag}`);
    const inbox: string[] = [];
    ws.onmessage = (e: MessageEvent) => inbox.push(String(e.data));
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    return { ws, inbox };
  };
  return { open };
};
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("P07h WebSocket hibernation API (ctx.acceptWebSocket)", () => {
  it("routes messages to webSocketMessage, broadcasts by tag, exposes tags and sockets", async () => {
    const { open } = setup();
    const a = await open("red");
    const b = await open("red");
    const c = await open("blue");
    a.ws.send("red:hi");
    await until(() => a.inbox.length > 0 && b.inbox.length > 0);
    expect([a.inbox, b.inbox, c.inbox]).toEqual([["red>hi"], ["red>hi"], []]);
    c.ws.send("tags?");
    c.ws.send("count?");
    await until(() => c.inbox.length >= 2);
    expect(c.inbox).toEqual(['["blue"]', "3"]);
  });

  it("webSocketClose receives code, reason, wasClean; the socket leaves getWebSockets()", async () => {
    Hub.closes = [];
    const { open } = setup();
    const a = await open("x");
    const b = await open("x");
    a.ws.close(4001, "bye");
    await until(() => Hub.closes.length > 0);
    expect(Hub.closes).toEqual([{ code: 4001, reason: "bye", wasClean: true }]);
    b.ws.send("count?");
    await until(() => b.inbox.length > 0);
    expect(b.inbox).toEqual(["1"]);
  });
});
