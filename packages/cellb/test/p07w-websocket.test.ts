import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { WsFrame } from "@statewalker/webrun-http-browser/sw";
import { newHostRegistry, newModuleServer } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import {
  CellsResponse,
  createCellRuntime,
  createWebSocketClass,
  DurableObject,
  takeClientPort,
  WebSocketPair,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import type { Frame } from "../src/ws/frames.js";

// cellb's frames are webrun-http-browser's, declared again (src/ws/frames.ts): either way round.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const framesAreThePackages: Same<Frame, WsFrame> = true;
void framesAreThePackages;

/** Cloudflare-style chat room: accepts sockets, echoes, broadcasts, closes on "bye". */
class Room extends DurableObject {
  sockets = new Set<any>();
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("message", (e: any) => {
      if (e.data === "bye") return server.close(4000, "bye bye");
      if (typeof e.data !== "string")
        return server.send(new Uint8Array([...new Uint8Array(e.data)].reverse()));
      for (const s of this.sockets) s.send(`${e.data}`);
    });
    server.addEventListener("close", () => this.sockets.delete(server));
    const proto = req.headers.get("Sec-WebSocket-Protocol")?.split(",")[0]?.trim();
    return new CellsResponse(null, {
      status: 101,
      webSocket: client,
      headers: proto ? { "Sec-WebSocket-Protocol": proto } : {},
    });
  }
}
const worker = {
  Room,
  default: {
    fetch(req: Request, env: any) {
      const m = new URL(req.url).pathname.match(/^\/room\/(\w+)$/);
      return m ? env.ROOM.getByName(m[1]).fetch(req) : new Response("no", { status: 404 });
    },
  },
};

const setup = () => {
  const rt = createCellRuntime({
    worker,
    durableObjects: { ROOM: { className: "Room" } },
    openSql: nodeSqliteOpener(),
  });
  const WS = createWebSocketClass((url, protocols) => rt.connectWebSocket(url, protocols));
  return { rt, WS };
};
const next = (ws: any, type: string) =>
  new Promise<any>((r) => ws.addEventListener(type, r, { once: true }));

describe("P07w WebSockets over MessagePorts (CF WebSocketPair on the DO side, WHATWG WebSocket on the client)", () => {
  it("opens, negotiates the protocol, echoes text and binary, broadcasts to all sockets of the room", async () => {
    const { WS } = setup();
    const a = new WS("ws://cells.local/room/r1", ["chat.v1", "chat.v0"]);
    expect(a.readyState).toBe(WS.CONNECTING);
    await next(a, "open");
    expect(a.readyState).toBe(WS.OPEN);
    expect(a.protocol).toBe("chat.v1");
    const b = new WS("ws://cells.local/room/r1");
    await next(b, "open");
    const got = Promise.all([next(a, "message"), next(b, "message")]);
    a.send("hello");
    expect((await got).map((e) => e.data)).toEqual(["hello", "hello"]);
    a.binaryType = "arraybuffer";
    const bin = next(a, "message");
    a.send(new Uint8Array([1, 2, 3]));
    expect([...new Uint8Array((await bin).data)]).toEqual([3, 2, 1]);
  });

  it("server-initiated close: code and reason reach the client, clean close, readyState CLOSED", async () => {
    const { WS } = setup();
    const ws = new WS("ws://cells.local/room/r2");
    await next(ws, "open");
    const closed = next(ws, "close");
    ws.send("bye");
    const ev = await closed;
    expect([ev.code, ev.reason, ev.wasClean, ws.readyState]).toEqual([
      4000,
      "bye bye",
      true,
      WS.CLOSED,
    ]);
  });

  it("client-initiated close completes the handshake; later sends are ignored", async () => {
    const { WS } = setup();
    const ws = new WS("ws://cells.local/room/r3");
    await next(ws, "open");
    const closed = next(ws, "close");
    ws.close(1000, "done");
    expect(ws.readyState).toBe(WS.CLOSING);
    const ev = await closed;
    expect([ev.code, ev.reason, ev.wasClean]).toEqual([1000, "done", true]);
    expect(() => ws.send("late")).not.toThrow();
  });

  it("refused upgrade → error then close 1006; API guards like the browser's", async () => {
    const { WS } = setup();
    const bad = new WS("ws://cells.local/nowhere");
    const events: string[] = [];
    bad.onerror = () => events.push("error");
    const ev = await new Promise<any>((r) => (bad.onclose = r));
    expect(events).toEqual(["error"]);
    expect([ev.code, ev.wasClean]).toEqual([1006, false]);
    const ws = new WS("ws://cells.local/room/r4");
    expect(() => ws.send("x")).toThrow(/CONNECTING/);
    expect(() => ws.close(1001)).toThrow(/close code/);
    expect(() => new WS("ftp://x/")).toThrow(/scheme/);
    // binaryType takes only "blob" and "arraybuffer" (case-sensitive); anything else is ignored
    ws.binaryType = "arraybuffer";
    (ws as { binaryType: string }).binaryType = "BLOB";
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("CellsResponse takes another Response as its init, as Fetch does (status, statusText, headers)", async () => {
    const first = new CellsResponse("{}", {
      status: 201,
      statusText: "Made",
      headers: { "content-type": "application/json", "x-a": "1" },
    });
    const copy = new CellsResponse("[]", first);
    expect([
      copy.status,
      copy.statusText,
      copy.headers.get("content-type"),
      copy.headers.get("x-a"),
    ]).toEqual([201, "Made", "application/json", "1"]);
    expect(await copy.text()).toBe("[]");
  });

  it("a WebSocketPair destructures as [client, server], as in workerd", () => {
    const pair = new WebSocketPair();
    const [client, server] = pair as unknown as Iterable<unknown>;
    expect([client, server]).toEqual([pair[0], pair[1]]);
  });
});

describe("P07w user code built by webrun-modules: WebSocket / WebSocketPair / Response come from ~deps", () => {
  it("unmodified CF worker + browser-style client code run with host-provided globals", async () => {
    const project = new MemFilesApi();
    // Authored exactly as for Cloudflare / a browser — no imports of the shims.
    await writeText(
      project,
      "/chat.ts",
      `
      import { DurableObject } from "cloudflare:workers";
      export class Room extends DurableObject {
        async fetch(req: Request) {
          const pair = new WebSocketPair();
          const server = pair[1];
          server.accept();
          server.addEventListener("message", (e) => server.send("echo:" + e.data));
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
      }
      export default { fetch: (req, env) => env.ROOM.getByName("main").fetch(req) };
    `,
    );
    await writeText(
      project,
      "/client.ts",
      `
      export function talk(url: string, text: string): Promise<string> {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.onopen = () => ws.send(text);
          ws.onmessage = (e) => { resolve(e.data); ws.close(); };
          ws.onerror = () => reject(new Error("ws error"));
        });
      }
    `,
    );
    // Every binding must be registered BEFORE the first served module is imported:
    // since webrun-modules 0.3 the globals proxy is one shared module per directory
    // (~deps/~globals.js), evaluated once per realm. The client class reaches the
    // runtime lazily, through `rt` assigned below.
    let rt: ReturnType<typeof createCellRuntime> | undefined;
    const registry = newHostRegistry({
      "cloudflare:workers": { DurableObject },
      WebSocketPair,
      Response: CellsResponse,
      WebSocket: createWebSocketClass((url, p) => rt!.connectWebSocket(url, p)),
    });
    const host = `globalThis.__webrunHostRegistry.get`;
    const server = newModuleServer({
      cache: new MemFilesApi(),
      project,
      target: "browser",
      provided: registry,
      globals: {
        WebSocket: `${host}("WebSocket")`,
        WebSocketPair: `${host}("WebSocketPair")`,
        Response: `${host}("Response")`,
      },
    });
    // Materialize the served modules and import them (what a browser would fetch).
    const out = mkdtempSync(join(tmpdir(), "wm-out-"));
    const load = async (entry: string) => {
      const urls = await server.listResources({ url: entry });
      for (const u of urls) {
        const file = join(out, ...u.split("/"));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, await (await server.fetch(new Request(`http://x${u}`))).text());
      }
      const main = urls.find((u) => u.endsWith(entry) && !u.includes("~deps"))!;
      return { mod: await import(/* @vite-ignore */ join(out, ...main.split("/"))), urls };
    };
    const chat = await load("/chat.ts");
    expect(chat.urls.some((u) => u.includes("~deps"))).toBe(true);
    rt = createCellRuntime({
      worker: chat.mod,
      durableObjects: { ROOM: { className: "Room" } },
      openSql: nodeSqliteOpener(),
    });
    const client = await load("/client.ts");
    expect(await client.mod.talk("ws://cells.local/", "hi")).toBe("echo:hi");
    expect(
      typeof globalThis.WebSocket === "undefined" ||
        globalThis.WebSocket !== registry.get("WebSocket"),
    ).toBe(true); // real global untouched
  });
});

describe("P07w heartbeat: MessagePorts never report a dead peer, so both ends ping", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("client: closes with 1006 when the server end stops answering pings", async () => {
    const { port1, port2 } = new MessageChannel(); // port2 is a server that never answers
    port2.start();
    const WS = createWebSocketClass(async () => ({ port: port1 }), { heartbeatMs: 50 });
    const ws = new WS("ws://x/");
    await next(ws, "open");
    const t0 = Date.now();
    const ev = await next(ws, "close");
    expect([ev.code, ev.wasClean]).toEqual([1006, false]);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("server: a CfWebSocket closes with 1006 when the client stops pinging", async () => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const port = takeClientPort(pair[0]);
    port.start();
    port.postMessage({ t: "p", hb: 50 }); // one ping, then silence (tab closed)
    const ev = await new Promise<any>((r) => server.addEventListener("close", r, { once: true }));
    expect([ev.code, ev.wasClean, server.readyState]).toEqual([1006, false, 3]);
  });

  it("server: keeps the first period, so a closing tab's last ping does not delay noticing it", async () => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const port = takeClientPort(pair[0]);
    port.start();
    port.postMessage({ t: "p", hb: 20 });
    await sleep(30);
    // webrun-http-browser's client announces 70 s when its page turns hidden, which a closing
    // tab does on its way out; then silence.
    port.postMessage({ t: "p", hb: 70_000 });
    const t0 = Date.now();
    const ev = await new Promise<any>((r) => server.addEventListener("close", r, { once: true }));
    expect([ev.code, ev.wasClean]).toEqual([1006, false]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("server: acknowledges the bytes it dispatched (the client's bufferedAmount)", async () => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const port = takeClientPort(pair[0]);
    const frames: unknown[] = [];
    port.onmessage = (e) => frames.push(e.data);
    port.postMessage({ t: "m", d: "héllo" }); // 6 UTF-8 bytes
    port.postMessage({ t: "m", d: new ArrayBuffer(3) });
    await sleep(20);
    expect(frames).toEqual([
      { t: "a", n: 6 },
      { t: "a", n: 3 },
    ]);
    port.close();
  });

  it("a live socket stays open across many heartbeat periods", async () => {
    const { WS: base } = setup();
    void base;
    const rt = createCellRuntime({
      worker,
      durableObjects: { ROOM: { className: "Room" } },
      openSql: nodeSqliteOpener(),
    });
    const WS = createWebSocketClass((url, p) => rt.connectWebSocket(url, p), { heartbeatMs: 20 });
    const ws = new WS("ws://cells.local/room/hb");
    await next(ws, "open");
    await sleep(250);
    expect(ws.readyState).toBe(WS.OPEN);
    const msg = next(ws, "message");
    ws.send("still here");
    expect((await msg).data).toBe("still here");
  });
});

describe("P07w client rules cellb keeps over webrun-http-browser's client", () => {
  const WS = createWebSocketClass(async () => {
    throw new Error("not connecting");
  });
  it("duplicate subprotocols are refused case-insensitively", () => {
    expect(() => new WS("ws://x/", ["chat", "CHAT"])).toThrow(/duplicated/);
  });
  it("a relative url resolves against http://localhost/ where there is no page", async () => {
    const urls: string[] = [];
    const Rel = createWebSocketClass(async (url) => {
      urls.push(url);
      throw new Error("not connecting");
    });
    const ws = new Rel("/room/a");
    expect(ws.url).toBe("ws://localhost/room/a");
    await new Promise((r) => ws.addEventListener("close", r, { once: true }));
    expect(urls).toEqual(["ws://localhost/room/a"]);
  });
  it("an url that does not parse is still refused with SyntaxError", () => {
    expect(() => new WS("http://[")).toThrow(/invalid/);
  });
});

describe("P07w the celld peer bridge's socket to a cell", () => {
  const upgrade = (protocol: string) => {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (e: any) => server.send(`echo:${e.data}`));
    return new CellsResponse(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": protocol },
    }) as Response & { webSocket: any };
  };

  it("asks for the subprotocols the far client offered, so the cell's pick is accepted", async () => {
    const { cellSocket } = await import("../src/peer/celld-peer.js");
    const cell = cellSocket(upgrade("v1"), "v0, v1");
    await next(cell, "open");
    expect(cell.protocol).toBe("v1");
    const reply = next(cell, "message");
    cell.send("hi");
    expect((await reply).data).toBe("echo:hi");
    cell.close();
  });

  it("(why) a client that asked for none refuses the subprotocol the cell picked", async () => {
    const { cellSocket } = await import("../src/peer/celld-peer.js");
    const cell = cellSocket(upgrade("v1"), undefined);
    const ev = await next(cell, "close");
    expect(ev.code).toBe(1006);
  });
});
