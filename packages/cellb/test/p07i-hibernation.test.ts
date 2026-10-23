import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CellsResponse,
  createCellRuntime,
  createWebSocketClass,
  DurableObject,
  WebSocketPair,
} from "../src/index.js";

/** Counts constructions; keeps an in-memory field to show the instance really went away. */
class Sleepy extends DurableObject {
  static constructed = 0;
  static closes: number[] = [];
  memory = 0;
  constructor(ctx: any, env: any) {
    super(ctx, env);
    Sleepy.constructed++;
  }
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    if (url.searchParams.has("standard")) {
      pair[1].accept(); // standard WebSocket: pins the object
      pair[1].addEventListener("message", (e: any) => pair[1].send(`std:${e.data}`));
    } else {
      this.ctx.acceptWebSocket(pair[1], ["t"]);
      pair[1].serializeAttachment({ name: url.searchParams.get("name") });
    }
    return new CellsResponse(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: any, msg: string) {
    this.memory++;
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    ws.send(
      JSON.stringify({
        msg,
        n,
        memory: this.memory,
        name: ws.deserializeAttachment().name,
        sockets: this.ctx.getWebSockets("t").length,
      }),
    );
  }
  async webSocketClose(_ws: any, code: number) {
    Sleepy.closes.push(code);
  }
}

const setup = () => {
  const rt = createCellRuntime({
    worker: { Sleepy, default: { fetch: (r: Request, env: any) => env.S.getByName("s").fetch(r) } },
    durableObjects: { S: { className: "Sleepy" } },
    openSql: nodeSqliteOpener(),
  });
  const WS = createWebSocketClass((url, p) => rt.connectWebSocket(url, p));
  const open = async (q: string) => {
    const ws = new WS(`ws://h/?${q}`);
    const inbox: string[] = [];
    ws.onmessage = (e: MessageEvent) => inbox.push(String(e.data));
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const next = async () => {
      for (let i = 0; i < 400 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 5));
      return inbox.shift()!;
    };
    return { ws, next };
  };
  return { rt, open };
};

describe("P07i hibernation", () => {
  it("an idle object with hibernatable sockets is dropped and re-created by the next message", async () => {
    Sleepy.constructed = 0;
    const { rt, open } = setup();
    const a = await open("name=ada");
    a.ws.send("one");
    expect(JSON.parse(await a.next())).toEqual({
      msg: "one",
      n: 1,
      memory: 1,
      name: "ada",
      sockets: 1,
    });
    expect(Sleepy.constructed).toBe(1);
    expect(rt.hibernateIdle(0)).toBe(1);
    a.ws.send("two"); // wakes it: constructor again, in-memory state gone, storage + attachment kept
    expect(JSON.parse(await a.next())).toEqual({
      msg: "two",
      n: 2,
      memory: 1,
      name: "ada",
      sockets: 1,
    });
    expect(Sleepy.constructed).toBe(2);
  });

  it("webSocketClose reaches a hibernated object", async () => {
    Sleepy.closes = [];
    const { rt, open } = setup();
    const a = await open("name=bob");
    a.ws.send("x");
    await a.next();
    expect(rt.hibernateIdle(0)).toBe(1);
    a.ws.close(4100, "bye");
    for (let i = 0; i < 100 && !Sleepy.closes.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(Sleepy.closes).toEqual([4100]);
  });

  it("a standard (accept()ed) WebSocket pins the object until it closes", async () => {
    const { rt, open } = setup();
    const s = await open("standard=1");
    s.ws.send("hi");
    expect(await s.next()).toBe("std:hi");
    expect(rt.hibernateIdle(0)).toBe(0);
    const closed = new Promise((r) => s.ws.addEventListener("close", r, { once: true }));
    s.ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.hibernateIdle(0)).toBe(1);
  });

  it("an object with work in flight does not hibernate", async () => {
    const { rt } = setup();
    const { runInDurableObject } = await import("../src/index.js");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const inFlight = runInDurableObject((rt.env.S as any).getByName("busy"), async () => held);
    await new Promise((r) => setTimeout(r, 10));
    expect(rt.hibernateIdle(0)).toBe(0);
    release();
    await inFlight;
    expect(rt.hibernateIdle(0)).toBe(1);
  });
});
