/**
 * A Worker that uses the global `WebSocket` as the Agents SDK's partyserver does: attachments
 * through `WebSocket.prototype`, `readyState` compared with `WebSocket.READY_STATE_OPEN`, and
 * hibernatable sockets (`ctx.acceptWebSocket`). Run on Node (test/p13) and in a browser
 * (e2e-browser/agents-sdk-host).
 */
export const AGENTS_WEBSOCKET_WORKER = `
import { DurableObject } from "cloudflare:workers";

const attach = (ws, v) => WebSocket.prototype.serializeAttachment.call(ws, v);
const attached = (ws) => WebSocket.prototype.deserializeAttachment.call(ws);
const open = (sockets) => sockets.filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);

export class Room extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") !== "websocket") return Response.json(this.globals());
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    attach(pair[1], { user: url.searchParams.get("user") });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws, msg) {
    const from = attached(ws).user;
    for (const peer of open(this.ctx.getWebSockets())) peer.send(from + ": " + msg);
  }
  /** The global's shape, and a hibernatable socket's attachment read back through it. */
  globals() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    attach(pair[1], { user: "probe" });
    const result = {
      states: [WebSocket.READY_STATE_CONNECTING, WebSocket.READY_STATE_OPEN,
        WebSocket.READY_STATE_CLOSING, WebSocket.READY_STATE_CLOSED, WebSocket.OPEN],
      pairEndIsWebSocket: pair[1] instanceof WebSocket,
      attachment: attached(this.ctx.getWebSockets().at(-1)),
      open: open(this.ctx.getWebSockets()).length > 0,
      client: typeof WebSocket === "function",
    };
    pair[1].close();
    return result;
  }
}
export default {
  fetch: (req, env) => env.ROOM.getByName("room").fetch(req),
};
`;

export const AGENTS_WEBSOCKET_CONFIG = {
  name: "agents-websocket",
  main: "index.js",
  durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
};

/** What a request without Upgrade answers when the global WebSocket is workerd's. */
export const EXPECTED_GLOBALS = {
  states: [0, 1, 2, 3, 1],
  pairEndIsWebSocket: true,
  attachment: { user: "probe" },
  open: true,
  client: true,
};
