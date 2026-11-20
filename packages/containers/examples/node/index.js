import { DurableObject } from "cloudflare:workers";

export class NodeApp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container; // celld: Docker; cellb: the engine its host gives it
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.container.running) {
      await this.container.start({ env: { CELL: this.ctx.id.name } });
      await this.container.waitForPort?.(8080, 60_000);
    }
    const res = await this.container
      .getTcpPort(8080)
      .fetch(`http://container${url.pathname}${url.search}`);
    return Response.json({ cell: this.ctx.id.name, fromContainer: await res.json() });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "alpha";
    return env.APP.get(env.APP.idFromName(name)).fetch(request);
  },
};
