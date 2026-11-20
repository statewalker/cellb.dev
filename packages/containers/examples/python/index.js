import { DurableObject } from "cloudflare:workers";
import { containerFor } from "@statewalker/cellb-containers/container";
import SERVER from "./server.py";

// The image for cellb: WASIX packages plus files, in place of celld's Dockerfile.
const IMAGE = {
  packages: ["python/python"],
  files: { "server.py": SERVER },
  entrypoint: ["python", "/workspace/server.py"],
};

export class PyRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // On celld this is ctx.container; on cellb the node's engine provides it.
    this.container = ctx.container ?? containerFor(ctx, IMAGE);
  }

  async fetch(request) {
    const url = new URL(request.url);
    let startedMs = 0;
    if (!this.container.running) {
      const t0 = Date.now();
      await this.container.start({ env: { CELL: this.ctx.id.name } });
      await this.container.waitForPort?.(8080, 60_000);
      startedMs = Date.now() - t0;
    }
    const visits = (this.ctx.storage.kv.get("visits") ?? 0) + 1;
    this.ctx.storage.kv.put("visits", visits);
    let fromContainer;
    if (url.pathname === "/destroy") {
      await this.container.destroy();
      fromContainer = { destroyed: true };
    } else {
      const res = await this.container.getTcpPort(8080).fetch(`http://container${url.pathname}${url.search}`);
      fromContainer = await res.json();
    }
    return Response.json({ cell: this.ctx.id.name, visits, startedMs, fromContainer });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "alpha";
    return env.PY.get(env.PY.idFromName(name)).fetch(request);
  },
};
