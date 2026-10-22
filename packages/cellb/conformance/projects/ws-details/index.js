// WebSocket details: hibernation API with tags and auto-response, attachments, socket
// listing, binary echo, a 101 to a request without Upgrade, an unaccepted pair.
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [url.searchParams.get("tag") ?? "none"]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    pair[1].serializeAttachment({ joined: 1 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, message) {
    if (message === "info")
      return ws.send(
        JSON.stringify({
          tags: this.ctx.getTags(ws),
          sockets: this.ctx.getWebSockets().length,
          tagged: this.ctx.getWebSockets("red").length,
          attachment: ws.deserializeAttachment(),
          auto: this.ctx.getWebSocketAutoResponse()?.request ?? null,
          readyState: ws.readyState,
        }),
      );
    if (message instanceof ArrayBuffer) return ws.send(`binary:${new Uint8Array(message).length}`);
    ws.send(`echo:${message}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/no-upgrade") {
      try {
        const r = await env.R.getByName("x").fetch("http://r/");
        return new Response(`status ${r.status}`);
      } catch (e) {
        return new Response(`rejected ${e.name}`);
      }
    }
    if (url.pathname === "/pair") {
      const pair = new WebSocketPair();
      return Response.json({
        readyState: pair[0].readyState,
        sendBeforeAccept: (() => {
          try {
            pair[0].send("x");
            return "ok";
          } catch (e) {
            return e.name;
          }
        })(),
      });
    }
    return env.R.getByName("room").fetch(request);
  },
};
