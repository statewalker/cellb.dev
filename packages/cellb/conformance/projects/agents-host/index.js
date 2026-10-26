// What the Cloudflare Agents SDK (and partyserver under it) takes from its host besides the
// Durable Object API: `env` and `exports` of `cloudflare:workers`, read while the module is
// evaluated, in the project's Worker and in loaded Workers; and a hibernatable WebSocket's
// attachment read through the global `WebSocket` class, as partyserver reads it.
import { DurableObject, env, exports, WorkerEntrypoint } from "cloudflare:workers";

const atLoad = env.GREETING;

export class Box extends DurableObject {
  hi() {
    return `box ${env.GREETING}`;
  }
}

export class Room extends DurableObject {
  fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: "conn-1" });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, message) {
    ws.send(
      JSON.stringify({
        message,
        viaPrototype: WebSocket.prototype.deserializeAttachment.call(ws),
        isWebSocket: ws instanceof WebSocket,
        open: WebSocket.READY_STATE_OPEN,
      }),
    );
  }
}

export class Holder extends DurableObject {
  async probe() {
    const cls = env.LOADER.get("agents-host-v1", loadedCode).getDurableObjectClass("Counter");
    return this.ctx.facets.get("counter", () => ({ class: cls })).probe();
  }
}

export class Greeter extends WorkerEntrypoint {
  greet() {
    return "hi from the host";
  }
}

const CODE = `
import { DurableObject, WorkerEntrypoint, env, exports } from "cloudflare:workers";
const atLoad = env.NAME;
export class Echo extends WorkerEntrypoint {
  ping() {
    return "pong";
  }
}
export class Counter extends DurableObject {
  probe() {
    return { name: env.NAME, same: env === this.env };
  }
}
export default {
  async fetch() {
    return Response.json({
      atLoad,
      now: env.NAME,
      greeting: await env.GREETER.greet(),
      viaExports: await exports.Echo.ping(),
    });
  },
};
`;
const loadedCode = () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "w.js",
  modules: { "w.js": CODE },
  env: { NAME: "loaded", GREETER: exports.Greeter({ props: {} }) },
});

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/env")
      return Response.json({
        atLoad,
        now: env.GREETING,
        viaExports: await exports.Box.getByName("a").hi(),
        viaEnv: await env.BOX.getByName("a").hi(),
      });
    if (pathname === "/loaded")
      return env.LOADER.get("agents-host-v1", loadedCode).getEntrypoint().fetch(request);
    if (pathname === "/loaded-class") return Response.json(await env.HOLDER.getByName("h").probe());
    if (pathname === "/ws") return env.ROOM.getByName("r").fetch(request);
    return new Response("not found", { status: 404 });
  },
};
