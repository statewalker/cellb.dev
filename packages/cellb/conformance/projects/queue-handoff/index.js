// Delayed queue messages sent on one runtime and delivered by another (same bucket).
import { DurableObject } from "cloudflare:workers";

export class Log extends DurableObject {
  async add(e) {
    const all = (await this.ctx.storage.get("all")) ?? [];
    all.push(e);
    await this.ctx.storage.put("all", all);
  }
  async all() {
    return ((await this.ctx.storage.get("all")) ?? []).sort((a, b) => a.body.localeCompare(b.body));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const body = url.searchParams.get("body");
      await env.Q.send(body, { contentType: "text", delaySeconds: Number(url.searchParams.get("delay") ?? 0) });
      return Response.json({ sent: body });
    }
    return Response.json(await env.LOG.getByName("log").all());
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      await env.LOG.getByName("log").add({ body: m.body, attempts: m.attempts });
      m.ack();
    }
  },
};
