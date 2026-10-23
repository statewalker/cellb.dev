// A Durable Object whose state lives in a facet (a child object with its own database),
// to check that facet storage moves between celld and webrun-cells.
import { DurableObject } from "cloudflare:workers";

export class Child extends DurableObject {
  async bump() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}

export class Parent extends DurableObject {
  async fetch() {
    const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Child }));
    const own = ((await this.ctx.storage.get("visits")) ?? 0) + 1;
    await this.ctx.storage.put("visits", own);
    return Response.json({ facet: await child.bump(), parent: own });
  }
}

export default {
  fetch(request, env) {
    return env.P.getByName("p").fetch(request);
  },
};
