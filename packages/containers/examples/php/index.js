import { DurableObject } from "cloudflare:workers";
import { containerFor } from "@statewalker/cellb-containers/container";
import INDEX from "./www/index.php";

// PHP's built-in web server, one per cell, with the site's files.
const IMAGE = {
  packages: ["php/php-32"],
  files: { "www/index.php": INDEX },
  entrypoint: ["php", "-S", "0.0.0.0:8080", "-t", "/workspace/www", "/workspace/www/index.php"],
};

export class PhpSite extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.container = ctx.container ?? containerFor(ctx, IMAGE);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.container.running) {
      await this.container.start({ env: { CELL: this.ctx.id.name } });
      await this.container.waitForPort?.(8080, 60_000);
    }
    const visits = (this.ctx.storage.kv.get("visits") ?? 0) + 1;
    this.ctx.storage.kv.put("visits", visits);
    const res = await this.container
      .getTcpPort(8080)
      .fetch(`http://container${url.pathname}${url.search}`);
    return Response.json({ cell: this.ctx.id.name, visits, fromContainer: await res.json() });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "alpha";
    return env.SITE.get(env.SITE.idFromName(name)).fetch(request);
  },
};
