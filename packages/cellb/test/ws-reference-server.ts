import { createServer, type Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * Reference implementation of the echo-room protocol (see `Room` in fixtures.ts) on a
 * REAL WebSocket server (`ws`). Native WebSockets (browser, Node) run the conformance
 * cases against it; webrun-cells sockets run the same cases against the Room DO.
 * Paths: /room/<name> upgrades; anything else is refused with 404.
 */
export async function startReferenceServer(
  port = 0,
): Promise<{ port: number; close(): Promise<void>; server: Server }> {
  const rooms = new Map<string, Set<WebSocket>>();
  // Plain HTTP too: GET /text/<n> answers n numbered lines (a fetch target for Workers).
  const server = createServer((req, res) => {
    const m = /^\/text\/(\d+)$/.exec(req.url ?? "");
    if (!m) return void res.writeHead(404).end();
    // CORS: browser-hosted runtimes fetch it cross-origin (celld, a server, does not need it).
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end(Array.from({ length: Number(m[1]) }, (_, i) => `line ${i + 1}`).join("\n"));
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/room\/([\w-]+)$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (!m) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = rooms.get(m[1]) ?? new Set<WebSocket>();
      rooms.set(m[1], room);
      room.add(ws);
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
          return ws.send(Uint8Array.from(bytes).reverse());
        }
        const d = data.toString();
        if (d === "where?") return ws.send("where:native");
        if (d === "count?") return ws.send(`count:${room.size}`);
        if (d.startsWith("big:")) return ws.send("x".repeat(Number(d.slice(4))));
        if (d === "bye") return ws.close(4000, "bye bye");
        for (const s of room) s.send(d);
      });
      ws.on("close", () => room.delete(ws));
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    server,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
      }),
  };
}
