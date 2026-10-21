// Facets and the Worker Loader beyond celld's example: loaded vs exported classes, separate
// databases per facet name, abort (keeps data) and delete (drops data), RPC to a loaded
// entrypoint, props on ctx.exports.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const LOADED = `
  import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
  export class Counter extends DurableObject {
    async bump() {
      const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
      this.ctx.storage.kv.put("n", n);
      return n;
    }
    async fetch(request) {
      return new Response("counter " + (await this.bump()));
    }
  }
  export class Calc extends WorkerEntrypoint {
    add(a, b) { return a + b; }
  }
`;

export class Local extends DurableObject {
  async hello() {
    return "local " + (this.ctx.props?.tag ?? "none");
  }
}

export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return this.ctx.props.greeting + ", " + name;
  }
}

export class Supervisor extends DurableObject {
  loaded() {
    return this.env.LOADER.get("facets-api-v1", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "app.js",
      modules: { "app.js": LOADED },
      env: {},
    }));
  }
  facet(name, cls) {
    return this.ctx.facets.get(name, () => ({ class: cls }));
  }
  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const counterClass = this.loaded().getDurableObjectClass("Counter");
    try {
      switch (op) {
        case "a":
          return Response.json({ a: await this.facet("a", counterClass).bump() });
        case "a-fetch":
          return new Response(await (await this.facet("a", counterClass).fetch("http://facet/")).text());
        case "b":
          return Response.json({ b: await this.facet("b", counterClass).bump() });
        case "abort-a":
          this.ctx.facets.abort("a", new Error("a was aborted"));
          return Response.json({ aborted: true });
        case "delete-b":
          await this.ctx.facets.delete("b");
          return Response.json({ deleted: true });
        case "local":
          return Response.json({ local: await this.facet("local", this.ctx.exports.Local).hello() });
        case "calc":
          return Response.json({ sum: await this.loaded().getEntrypoint("Calc").add(2, 3) });
        case "greet":
          return Response.json({
            greeting: await this.ctx.exports.Greeter({ props: { greeting: "hi" } }).greet("ada"),
          });
        default:
          return new Response("unknown op", { status: 404 });
      }
    } catch (e) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
}

export default {
  fetch(request, env) {
    return env.SUPERVISOR.getByName("only").fetch(request);
  },
};
