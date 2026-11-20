// WebSockets into a container: `getTcpPort(port).fetch()` with an upgrade request answers 101 and
// carries the socket's port (@statewalker/webrun-http-browser's convention), and
// containerWebSocket(container, port) is a WHATWG WebSocket class over it. Here a Lifo container
// in a worker of its own, so the socket crosses the engine RPC too.
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import type { Container } from "../src/container.ts";
import { createIsolatedPool } from "../src/isolated-pool.ts";
import { containerWebSocket } from "../src/websocket.ts";

// A WebSocket echo server written against node:http's `upgrade` event (frames by hand: short text
// messages only), so the test needs no package from npm.
const server = `
const http = require("http");
const crypto = require("crypto");
const s = http.createServer((req, res) => res.end("plain"));
s.on("upgrade", (req, sock) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const proto = (req.headers["sec-websocket-protocol"] || "").split(",")[0].trim();
  sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + (proto ? "\\r\\nSec-WebSocket-Protocol: " + proto : "") + "\\r\\n\\r\\n");
  sock.on("data", (b) => {
    const op = b[0] & 15, masked = b[1] & 128, len = b[1] & 127;
    const mask = masked ? b.subarray(2, 6) : null, at = masked ? 6 : 2;
    const data = Buffer.from(b.subarray(at, at + len).map((x, i) => (mask ? x ^ mask[i % 4] : x)));
    if (op === 8) { sock.write(Buffer.from([0x88, 0])); sock.end(); return; }
    const out = Buffer.from("echo " + req.url + " " + data.toString());
    sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
});
s.listen(8080);
`;

const pool = createIsolatedPool({
  spawn: () => new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url)),
  image: {
    packages: [],
    files: { "server.js": server },
    entrypoint: ["node", "/workspace/server.js"],
  },
  size: 1,
});
afterAll(() => pool.close());

const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve, reject) => {
    ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
    ws.addEventListener("close", () => reject(new Error("closed")), { once: true });
  });
const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("error")), { once: true });
  });

describe("WebSockets into a Lifo container", () => {
  let c: Container;

  it("getTcpPort().fetch() of an upgrade answers 101 with the socket's port", async () => {
    c = await pool.acquire();
    await c.waitForPort?.(8080);
    const { newWebSocketUpgradeRequest, takeUpgrade } = await import(
      "@statewalker/webrun-http-browser"
    );
    const res = await c
      .getTcpPort(8080)
      .fetch(newWebSocketUpgradeRequest("ws://container/raw", { protocols: ["v1"] }));
    expect(res.status).toBe(101);
    const up = takeUpgrade(res);
    expect(up?.protocol).toBe("v1");
    up?.port.close();
  });

  it("containerWebSocket(): a WebSocket class whose sockets reach the container's server", async () => {
    const WS = containerWebSocket(c, 8080);
    const ws = new WS("ws://container/chat?room=1", ["v1"]) as unknown as WebSocket;
    await opened(ws);
    expect(ws.protocol).toBe("v1");
    ws.send("hello");
    expect(await nextMessage(ws)).toBe("echo /chat?room=1 hello");
    ws.send("again");
    expect(await nextMessage(ws)).toBe("echo /chat?room=1 again");
    const closed = new Promise<CloseEvent>((r) =>
      ws.addEventListener("close", (e) => r(e as CloseEvent), { once: true }),
    );
    ws.close(1000);
    expect((await closed).wasClean).toBe(true);
    // plain HTTP on the same port still works
    expect(await (await c.getTcpPort(8080).fetch("http://container/")).text()).toBe("plain");
  });

  it("a port with no WebSocket server: the socket fails", async () => {
    const WS = containerWebSocket(c, 9999);
    const ws = new WS("ws://container/") as unknown as WebSocket;
    await expect(opened(ws)).rejects.toThrow();
    await c.destroy();
  });
});

describe("WebSockets out of a Lifo container: a WebSocket class of the host's", () => {
  const out = createIsolatedPool({
    spawn: () => new Worker(new URL("./fixtures/lifo-websocket-worker.ts", import.meta.url)),
    image: { packages: [] },
    size: 1,
  });
  const plain = createIsolatedPool({
    spawn: () => new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url)),
    image: { packages: [] },
    size: 1,
  });
  afterAll(async () => {
    await out.close();
    await plain.close();
  });
  const guestGlobal = [
    "node",
    "-e",
    "const ws = new WebSocket('ws://host.internal/a'); ws.onopen = () => ws.send('hi'); ws.onmessage = (e) => { console.log(e.data); ws.close(); }; ws.onerror = () => console.log('error');",
  ];

  it("the guest's WebSocket is the host's class", async () => {
    const r = await out.run({ argv: guestGlobal, timeoutMs: 20_000 });
    expect(r.stdout).toBe("host /a hi\n");
  });

  it("so is node:http's upgrade client (Lifo calls it as ws's class: url, { protocols, headers })", async () => {
    const r = await out.run({
      argv: [
        "node",
        "-e",
        "const req = require('http').request({ host: 'host.internal', path: '/b', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } }); req.on('upgrade', (res, sock) => { sock.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x68, 0x69])); sock.on('data', (d) => { console.log(res.statusCode, d.subarray(2).toString()); sock.destroy(); }); }); req.on('error', (e) => console.log('error', e.message)); req.end();",
      ],
      timeoutMs: 20_000,
    });
    expect(r.stdout).toBe("101 host /b hi\n");
  });

  it("without one, a guest's WebSocket has no egress", async () => {
    const r = await plain.run({
      argv: [
        "node",
        "-e",
        "try { new WebSocket('wss://example.com/'); console.log('opened') } catch (e) { console.log('refused', e.message) }",
      ],
      timeoutMs: 20_000,
    });
    expect(r.stdout).toMatch(/^refused .*no egress/);
  });
});
