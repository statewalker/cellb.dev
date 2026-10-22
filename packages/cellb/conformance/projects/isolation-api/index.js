// Isolation of loaded Workers (celld runs each in its own V8 isolate): loaded code must not
// see the host's globals or env, its own global changes must not leak out, and it gets only
// the env its WorkerCode declares (plain values and service stubs).
import { WorkerEntrypoint } from "cloudflare:workers";

export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return `hello ${name} from the host`;
  }
}

const CODE = `
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

export default {
  async fetch(request, env, ctx) {
    globalThis.hostSecret = "set by the host";
    const worker = env.LOADER.get("isolated-v1", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "w.js",
      modules: { "w.js": CODE },
      env: { PLAIN: { n: 1, list: ["a"] }, GREETER: ctx.exports.Greeter() },
    }));
    const inner = await (await worker.getEntrypoint().fetch("http://w/")).json();
    return Response.json({ inner, leakedIntoHost: typeof globalThis.leaked });
  },
};
