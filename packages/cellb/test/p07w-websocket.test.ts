import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newHostRegistry, newModuleServer } from "@statewalker/webrun-modules";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CellsResponse,
  createCellRuntime,
  createWebSocketClass,
  DurableObject,
  WebSocketPair,
} from "../src/index.js";

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
    // Late-bound registry: the client class needs the runtime, created after the build.
    const registry = newHostRegistry({
      "cloudflare:workers": { DurableObject },
      WebSocketPair,
      Response: CellsResponse,
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
    const rt = createCellRuntime({
      worker: chat.mod,
      durableObjects: { ROOM: { className: "Room" } },
      openSql: nodeSqliteOpener(),
    });
    registry.set(
      "WebSocket",
      createWebSocketClass((url, p) => rt.connectWebSocket(url, p)),
    );
    const client = await load("/client.ts");
    expect(await client.mod.talk("ws://cells.local/", "hi")).toBe("echo:hi");
    expect(
      typeof globalThis.WebSocket === "undefined" ||
        globalThis.WebSocket !== registry.get("WebSocket"),
    ).toBe(true); // real global untouched
  });
});
