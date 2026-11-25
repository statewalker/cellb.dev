import { DurableObject } from "cloudflare:workers";

// The fragment DO: counts the requests it serves and says who it is and what path it saw.
export class Fragment extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/kv") {
      const value = url.searchParams.get("put");
      if (value !== null) await this.env.KV.put("k", value);
      return Response.json({ kv: await this.env.KV.get("k") });
    }
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return Response.json({
      label: this.env.LABEL,
      n,
      id: this.ctx.id.toString(),
      path: url.pathname,
    });
  }
}

export default {
  async fetch() {
    return new Response("the Worker's own fetch", { status: 200 });
  },
};
