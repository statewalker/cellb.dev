// An extension: a partyserver Server shipped as a prebuilt bundle and loaded at run time
// (Worker Loader). `activations` counts how often it started, `requests` its HTTP requests.
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
  /** Counts its requests in its own storage: facets that shared an object would share it. */
  async onRequest() {
    const requests = ((await this.ctx.storage.get("requests")) ?? 0) + 1;
    await this.ctx.storage.put("requests", requests);
    return Response.json({ plugin: this.name, activations: this.activations, requests });
  }
}

export default {
  fetch() {
    return new Response("plugin worker");
  },
};
