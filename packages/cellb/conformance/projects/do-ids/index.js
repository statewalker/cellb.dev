// Durable Object ids as celld derives them (HMAC-SHA-256 over the name, keyed by script and
// class), their validation, and what an object sees as ctx.id.
import { DurableObject } from "cloudflare:workers";

export class Alpha extends DurableObject {
  whoami() {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null };
  }
}
export class Beta extends Alpha {}

const err = (fn) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
};

export default {
  async fetch(request, env) {
    const a = env.A.idFromName("alpha");
    const unique = env.A.newUniqueId();
    const long = "x".repeat(1100);
    return Response.json({
      alpha: a.toString(),
      alphaInB: env.B.idFromName("alpha").toString(),
      empty: env.A.idFromName("").toString(),
      unicode: env.A.idFromName("héllo ✓").toString(),
      equals: a.equals(env.A.idFromName("alpha")),
      name: a.name,
      fromString: env.A.idFromString(a.toString()).toString() === a.toString(),
      fromStringName: env.A.idFromString(a.toString()).name ?? null,
      otherNamespace: err(() => env.B.idFromString(a.toString())),
      garbage: err(() => env.A.idFromString("zz")),
      uniqueLength: unique.toString().length,
      uniqueValid: env.A.idFromString(unique.toString()).equals(unique),
      seen: await env.A.get(a).whoami(),
      seenByName: await env.A.getByName("alpha").whoami(),
      longName: await env.A.getByName(long).whoami().then((w) => ({ named: w.name !== null })),
    });
  },
};
