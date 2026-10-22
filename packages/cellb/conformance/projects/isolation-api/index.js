// Isolation of loaded Workers (celld runs each in its own V8 isolate): loaded code must not
// see the host's globals or env, its own global changes must not leak out, and it gets only
// the env its WorkerCode declares (plain values and service stubs).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Holder extends DurableObject {
  async probe() {
    globalThis.hostSecret = "set by the host";
    const cls = this.env.LOADER.get("isolated-v1", loadedCode(this.ctx.exports)).getDurableObjectClass("Box");
    const box = this.ctx.facets.get("box", () => ({ class: cls }));
    const a = await box.probe();
    const b = await box.probe();
    return { a, b, leakedIntoHost: typeof globalThis.leakedFromFacet };
  }
}

export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return `hello ${name} from the host`;
  }
}

const CODE = `
import { DurableObject } from "cloudflare:workers";
export class Box extends DurableObject {
  probe() {
    const sawHost = typeof globalThis.hostSecret;
    globalThis.leakedFromFacet = 1;
    this.ctx.storage.kv.put("n", (this.ctx.storage.kv.get("n") ?? 0) + 1);
    return { sawHost, n: this.ctx.storage.kv.get("n") };
  }
}
const loadedCode = (exports) => () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "w.js",
  modules: { "w.js": CODE },
  env: { PLAIN: { n: 1, list: ["a"] }, GREETER: exports.Greeter() },
});

export default {
  async fetch(request, env) {
    const before = typeof globalThis.hostSecret;
    globalThis.leaked = "from loaded code";
    return Response.json({
      sawHostGlobal: before,
      envKeys: Object.keys(env).sort(),
      plain: env.PLAIN,
      viaStub: await env.GREETER.greet("loaded"),
      hostSecretInEnv: env.HOST_SECRET ?? null,
    });
  },
};`;

const loadedCode = (exports) => () => ({
  compatibilityDate: "2026-01-01",
  mainModule: "w.js",
  modules: { "w.js": CODE },
  env: { PLAIN: { n: 1, list: ["a"] }, GREETER: exports.Greeter() },
});

export default {
  async fetch(request, env, ctx) {
    globalThis.hostSecret = "set by the host";
    if (new URL(request.url).pathname === "/facet") return Response.json(await env.HOLDER.getByName("h").probe());
    const worker = env.LOADER.get("isolated-v1", loadedCode(ctx.exports));
    const inner = await (await worker.getEntrypoint().fetch("http://w/")).json();
    return Response.json({ inner, leakedIntoHost: typeof globalThis.leaked });
  },
};
