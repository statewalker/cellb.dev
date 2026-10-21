// Queues behaviour that celld and webrun-cells must share: delivery, attempts, retry,
// dead-lettering, delays, producer validation. The consumer records each delivery in a
// Durable Object; the log is returned sorted (celld guarantees no order).
import { DurableObject } from "cloudflare:workers";

export class Log extends DurableObject {
  async add(entry) {
    const n = (await this.ctx.storage.get("n")) ?? 0;
    await this.ctx.storage.put({ n: n + 1, [`e${String(n).padStart(4, "0")}`]: entry });
  }
  async entries() {
    const all = await this.ctx.storage.list({ prefix: "e" });
    return [...all.values()].sort();
  }
}

const log = (env) => env.LOG.getByName("log");

export default {
  async fetch(request, env) {
    const step = new URL(request.url).pathname.slice(1);
    if (step === "send") {
      await env.QUEUE.send({ n: 1 });
      await env.QUEUE.send("plain", { contentType: "text" });
      await env.QUEUE.sendBatch([
        { body: { n: 2 } },
        { body: "fail" },
        { body: { n: 3 }, delaySeconds: 1 },
      ]);
      return Response.json({ sent: 5 });
    }
    if (step === "errors") {
      const tryIt = async (fn) => {
        try {
          await fn();
          return "ok";
        } catch (e) {
          return e.name;
        }
      };
      return Response.json({
        tooLate: await tryIt(() => env.QUEUE.send(1, { delaySeconds: 90_000 })),
        tooMany: await tryIt(() =>
          env.QUEUE.sendBatch(Array.from({ length: 101 }, (_, i) => ({ body: i }))),
        ),
        textNotString: await tryIt(() => env.QUEUE.send(42, { contentType: "text" })),
      });
    }
    if (step === "log") return Response.json(await log(env).entries());
    return new Response("unknown step", { status: 404 });
  },

  async queue(batch, env) {
    for (const m of batch.messages) {
      await log(env).add(`${batch.queue} ${JSON.stringify(m.body)} attempt=${m.attempts}`);
      if (m.body === "fail" && batch.queue === "work") m.retry();
      else m.ack();
    }
  },
};
