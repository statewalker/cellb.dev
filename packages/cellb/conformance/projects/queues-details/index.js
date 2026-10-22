// Queue producer validation and message shapes as celld implements them.
import { DurableObject } from "cloudflare:workers";

export class Log extends DurableObject {
  async add(e) {
    const n = (await this.ctx.storage.get("n")) ?? 0;
    await this.ctx.storage.put({ n: n + 1, [`e${String(n).padStart(4, "0")}`]: e });
  }
  async all() {
    return [...(await this.ctx.storage.list({ prefix: "e" })).values()].sort((a, b) => a.k.localeCompare(b.k));
  }
}
const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 160)}`;
  }
};

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    if (op === "validate")
      return Response.json({
        bigMessage: await tryIt(() => env.Q.send("x".repeat(130_000))),
        negativeDelay: await tryIt(() => env.Q.send(1, { delaySeconds: -1 })),
        hugeDelay: await tryIt(() => env.Q.send(1, { delaySeconds: 43_201 })),
        maxDelay: await tryIt(() => env.Q.send(1, { delaySeconds: 43_200 })),
        badType: await tryIt(() => env.Q.send(1, { contentType: "yaml" })),
        fn: await tryIt(() => env.Q.send(() => 1)),
        jsonUndefined: await tryIt(() => env.Q.send(undefined)),
        emptyBatch: await tryIt(() => env.Q.sendBatch([])),
        batch101: await tryIt(() => env.Q.sendBatch(Array.from({ length: 101 }, (_, i) => ({ body: i })))),
        batchBytes: await tryIt(() => env.Q.sendBatch(Array.from({ length: 3 }, () => ({ body: "y".repeat(100_000) })))),
        sendResult: await tryIt(async () => typeof (await env.Q.send("r"))),
      });
    if (op === "send") {
      await env.Q.send({ k: "json", d: new Date(0).toISOString() });
      await env.Q.send("text body", { contentType: "text" });
      await env.Q.send(new Uint8Array([1, 2, 3]), { contentType: "bytes" });
      await env.Q.send({ k: "v8", when: new Date(0), m: new Map([["a", 1]]) }, { contentType: "v8" });
      return Response.json({ sent: 4 });
    }
    if (op === "log") return Response.json(await env.LOG.getByName("l").all());
    return new Response("?", { status: 404 });
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      const b = m.body;
      const shape =
        b instanceof ArrayBuffer
          ? `ArrayBuffer:${[...new Uint8Array(b)]}`
          : ArrayBuffer.isView(b)
            ? `${b.constructor.name}:${[...b]}`
            : b && typeof b === "object" && b.when instanceof Date
              ? `v8:${b.when.toISOString()}:${b.m instanceof Map ? "Map" : typeof b.m}`
              : JSON.stringify(b);
      await env.LOG.getByName("l").add({
        k: typeof b === "string" ? b : (b?.k ?? shape),
        shape,
        idLooksLikeUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.id),
        timestampIsDate: m.timestamp instanceof Date,
        attempts: m.attempts,
      });
    }
  },
};
