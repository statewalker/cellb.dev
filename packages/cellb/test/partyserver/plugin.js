// An extension: a partyserver Server shipped as a prebuilt bundle and loaded at run time
// (Worker Loader). `activations` counts how often it started, across restarts.
import { Server } from "partyserver";

export class Plugin extends Server {
  static options = { hibernate: true };
  async onStart() {
    this.activations = ((await this.ctx.storage.get("activations")) ?? 0) + 1;
    await this.ctx.storage.put("activations", this.activations);
  }
  onConnect(conn) {
    conn.send(JSON.stringify({ plugin: this.name, hello: true }));
  }
  onMessage(_conn, msg) {
    this.broadcast(JSON.stringify({ plugin: this.name, echo: String(msg) }));
  }
  onRequest() {
    return Response.json({ plugin: this.name, activations: this.activations });
  }
}

export default {
  fetch() {
    return new Response("plugin worker");
  },
};
