// Runtime APIs beyond celld's examples: Cache API, service bindings (default and named
// entrypoints, fetch and RPC), KV bulk get, Worker Loader load()/globalOutbound, WebSocket
// attachments with the hibernation API.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class MathApi extends WorkerEntrypoint {
  add(a, b) {
    return a + b;
  }
  async fetch(request) {
    return new Response("math via fetch " + new URL(request.url).pathname);
  }
}

export class Room extends DurableObject {
  async fetch(request) {
    const pair = new WebSocketPair();
    const name = new URL(request.url).searchParams.get("name") ?? "anon";
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ name, joined: 1 });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment();
    ws.serializeAttachment({ ...att, joined: att.joined + 1 });
    ws.send(JSON.stringify({ from: att.name, message, seen: att.joined }));
  }
}

const tryIt = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return `${e.name}`;
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    if (url.pathname.startsWith("/room")) return env.ROOM.getByName("r").fetch(request);
    switch (op) {
      case "cache": {
        const cache = caches.default;
        const key = new Request("https://example.com/cached");
        const put = await cache.put(key, new Response("body"));
        const named = await caches.open("named");
        return Response.json({
          put: put === undefined,
          match: (await cache.match(key)) === undefined,
          deleted: await cache.delete(key),
          namedMatch: (await named.match(key)) === undefined,
        });
      }
      case "self":
        return new Response(`self says: ${await (await env.SELF.fetch("http://self/echo")).text()}`);
      case "echo":
        return new Response("echo");
      case "math":
        return Response.json({
          sum: await env.MATH.add(2, 40),
          viaFetch: await (await env.MATH.fetch("http://math/x")).text(),
        });
      case "kv": {
        await env.KV.put("a", "1");
        await env.KV.put("b", JSON.stringify({ b: 2 }));
        const texts = await env.KV.get(["a", "b", "missing"]);
        const json = await env.KV.get(["b"], "json");
        return Response.json({ texts: [...texts.entries()], json: [...json.entries()] });
      }
      case "load": {
        const worker = env.LOADER.load({
          compatibilityDate: "2026-01-01",
          mainModule: "w.js",
          modules: { "w.js": "export default { async fetch() { return new Response('loaded once'); } }" },
        });
        const sealed = env.LOADER.get("sealed-v1", () => ({
          compatibilityDate: "2026-01-01",
          mainModule: "s.js",
          modules: {
            "s.js":
              "export default { async fetch() { try { await fetch('http://example.com/'); return new Response('fetched'); } catch (e) { return new Response('blocked: ' + e.name); } } }",
          },
          globalOutbound: null,
        }));
        return Response.json({
          load: await (await worker.getEntrypoint().fetch("http://w/")).text(),
          sealed: await (await sealed.getEntrypoint().fetch("http://s/")).text(),
        });
      }
      default:
        return new Response("unknown op", { status: 404 });
    }
  },
};
