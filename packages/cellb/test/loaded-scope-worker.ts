/**
 * A Worker that loads code reading `env` and `exports` of `cloudflare:workers`, while its
 * module is evaluated and later, from its entrypoint and from a Durable Object class run as a
 * facet. Run on Node (test/p13) and in a browser (e2e-browser/agents-sdk-host).
 */
export const LOADED_SCOPE_WORKER = `
import { DurableObject, WorkerEntrypoint, exports } from "cloudflare:workers";

const LOADED = \`
import { DurableObject, WorkerEntrypoint, env, exports } from "cloudflare:workers";
const atLoad = env.NAME;
export class Echo extends WorkerEntrypoint {
  ping() { return "pong"; }
}
export class Counter extends DurableObject {
  probe() { return env.NAME; }
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
\`;
const code = () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "w.js",
  modules: { "w.js": LOADED },
  env: { NAME: "loaded", GREETER: exports.Greeter({ props: {} }) },
});

export class Greeter extends WorkerEntrypoint {
  greet() { return "hi from the host"; }
}
export class Holder extends DurableObject {
  probe() {
    const cls = this.env.LOADER.get("w", code).getDurableObjectClass("Counter");
    return this.ctx.facets.get("counter", () => ({ class: cls })).probe();
  }
}
export default {
  async fetch(req, env) {
    const loaded = await env.LOADER.get("w", code).getEntrypoint().fetch(req);
    return Response.json({
      ...(await loaded.json()),
      inFacet: await env.HOLDER.getByName("h").probe(),
    });
  },
};
`;

export const LOADED_SCOPE_CONFIG = {
  name: "loaded-scope",
  main: "index.js",
  worker_loaders: [{ binding: "LOADER" }],
  durable_objects: { bindings: [{ name: "HOLDER", class_name: "Holder" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Holder"] }],
};

/** What the loaded code answers when its `cloudflare:workers` is its own. */
export const EXPECTED_LOADED_SCOPE = {
  atLoad: "loaded",
  now: "loaded",
  greeting: "hi from the host",
  viaExports: "pong",
  inFacet: "loaded",
};
