import { DurableObject } from "cloudflare:workers";
import { routePartykitRequest, Server } from "partyserver";
import { Scheduler } from "partywhen";

export { Scheduler };

/** A party room: hibernating WebSockets, broadcast, storage, and a task partywhen runs. */
export class Room extends Server {
  static options = { hibernate: true };
  async onStart() {
    this.n = (await this.ctx.storage.get("n")) ?? 0;
    this.ticks = (await this.ctx.storage.get("ticks")) ?? 0;
  }
  onConnect(conn) {
    conn.send(JSON.stringify({ room: this.name, n: this.n }));
  }
  async onMessage(_conn, msg) {
    this.n++;
    await this.ctx.storage.put("n", this.n);
    this.broadcast(JSON.stringify({ room: this.name, n: this.n, msg: String(msg) }));
  }
  onRequest() {
    return Response.json({ room: this.name, n: this.n, ticks: this.ticks });
  }
  /** Called by partywhen's Scheduler when a task is due. */
  async onTask(task) {
    this.ticks++;
    await this.ctx.storage.put("ticks", this.ticks);
    this.broadcast(JSON.stringify({ task: task.payload }));
  }
}

/** One object per extension: the extension's partyserver Server runs as its facet. */
export class ExtensionHost extends DurableObject {
  fetch(request) {
    const name = new URL(request.url).pathname.split("/")[2];
    const worker = this.env.LOADER.get(`${name}@1`, () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "plugin.js",
      modules: { "plugin.js": this.env.PLUGIN_CODE },
    }));
    const facet = this.ctx.facets.get(name, () => ({
      class: worker.getDurableObjectClass("Plugin"),
      // partyserver's `this.name` is the facet's own id's name.
      id: this.ctx.exports.ExtensionHost.idFromName(`facet:${name}`),
    }));
    return facet.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/schedule") {
      await env.SCHEDULER.getByName("main").scheduleTask({
        description: "tick",
        type: "delayed",
        delayInSeconds: 1,
        payload: { hello: "from partywhen" },
        callback: { type: "durable-object", namespace: "Room", name: "lobby", function: "onTask" },
      });
      return new Response("scheduled");
    }
    if (url.pathname.startsWith("/ext/"))
      return env.EXT_HOST.getByName(url.pathname.split("/")[2]).fetch(request);
    return (await routePartykitRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
};
