// Authored exactly as for Cloudflare Workers / celld — no webrun-cells imports.
// Served by webrun-modules: `WebSocketPair`, `Response` and "cloudflare:workers" are
// rewritten to ~deps proxies bound to the host registry of the realm that imports it.
import { DurableObject } from "cloudflare:workers";

export class Lobby extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("websocket only", { status: 426 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event: MessageEvent) => server.send(`lobby:${event.data}`));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export default {
  fetch(request: Request, env: { LOBBY: DurableObjectNamespace }): Promise<Response> {
    const name = new URL(request.url).pathname.split("/")[2] ?? "main";
    return env.LOBBY.getByName(name).fetch(request);
  },
};
