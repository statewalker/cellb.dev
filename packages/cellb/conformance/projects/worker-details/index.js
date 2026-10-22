// Worker and RPC details: uncaught errors, RPC errors and values, request.cf, headers,
// redirects, wrong return types.
import { DurableObject, RpcTarget } from "cloudflare:workers";

class Counter extends RpcTarget {
  #n = 0;
  inc() {
    return ++this.#n;
  }
}

export class Obj extends DurableObject {
  boom() {
    const e = new RangeError("out of range");
    e.code = "E_RANGE";
    throw e;
  }
  values() {
    return { date: new Date(0), map: new Map([["a", 1]]), bytes: new Uint8Array([1, 2]), big: 10n, undef: undefined };
  }
  fn() {
    return () => 1;
  }
  target() {
    return new Counter();
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/throw") throw new Error("object fetch failed");
    return new Response("object ok");
  }
}

const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return { name: e.name, message: String(e.message).split("\n")[0].slice(0, 160), code: e.code ?? null };
  }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const stub = env.D.getByName("o");
    switch (url.pathname) {
      case "/throw":
        throw new TypeError("handler failed");
      case "/not-response":
        return "a string";
      case "/rpc":
        return Response.json({
          boom: await tryIt(() => stub.boom()),
          values: await tryIt(async () => {
            const v = await stub.values();
            return { date: v.date instanceof Date, map: v.map instanceof Map, bytes: [...v.bytes], big: typeof v.big, undef: "undef" in v };
          }),
          fn: await tryIt(async () => typeof (await stub.fn())),
          target: await tryIt(async () => {
            const c = await stub.target();
            return [await c.inc(), await c.inc()];
          }),
          missing: await tryIt(() => stub.nope()),
          objectThrow: await tryIt(() => stub.fetch("http://o/throw")),
        });
      case "/cf":
        return Response.json({ hasCf: typeof request.cf, keys: Object.keys(request.cf ?? {}).sort() });
      case "/headers": {
        const h = new Headers();
        h.append("set-cookie", "a=1");
        h.append("set-cookie", "b=2");
        h.set("x-multi", "1, 2");
        return new Response("h", { headers: h });
      }
      case "/redirect":
        return Response.redirect("https://example.com/target", 301);
      case "/passthrough":
        ctx.passThroughOnException();
        throw new Error("after passThroughOnException");
      default:
        return new Response("?", { status: 404 });
    }
  },
};
