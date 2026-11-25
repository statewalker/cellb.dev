import { DurableObject, env } from "cloudflare:workers";

// The fragment DO: counts the requests it serves and says who it is and what path it saw.
export class Fragment extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    // Through the module's own `env` (cloudflare:workers), not this.env: each fragment's own.
    if (url.pathname === "/modkv") {
      const value = url.searchParams.get("put");
      if (value !== null) await env.KV.put("m", value);
      return Response.json({ own: await env.KV.get("m"), label: env.LABEL });
    }
    if (url.pathname === "/ws" && request.headers.get("upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (e) => server.send(`${this.env.LABEL}: ${e.data}`));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/set-cookie")
      return new Response("set", { headers: { "Set-Cookie": "fragcookie=1; Path=/" } });
    if (url.pathname === "/cookie") return new Response(request.headers.get("cookie") ?? "(none)");
    if (url.pathname === "/kv") {
      const value = url.searchParams.get("put");
      if (value !== null) await this.env.KV.put("k", value);
      return Response.json({ kv: await this.env.KV.get("k") });
    }
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return Response.json({
      label: this.env.LABEL,
      n,
      id: this.ctx.id.toString(),
      path: url.pathname,
    });
  }
}

export default {
  async fetch() {
    return new Response("the Worker's own fetch", { status: 200 });
  },
};
