import { DurableObject } from "cloudflare:workers";

// A cell that runs its container's job script on every request and counts the runs in its
// storage. Wherever the cell lives, the node that owns it starts the same image
// (cellb.containers.Runner) and runs the same script: after a move, the count goes on.
export class Runner extends DurableObject {
  async fetch() {
    const c = this.ctx.container;
    let startMs = 0;
    if (!c.running) {
      const t = Date.now();
      await c.start();
      startMs = Date.now() - t;
    }
    const runs = ((await this.ctx.storage.get("runs")) ?? 0) + 1;
    await this.ctx.storage.put("runs", runs);
    const t = Date.now();
    const r = await c.exec([...this.env.JOB.split(" "), String(runs)]);
    return Response.json({
      id: this.ctx.id.toString(),
      runs,
      startMs,
      execMs: Date.now() - t,
      exitCode: r.exitCode,
      out: r.stdout.trim(),
      err: r.stderr.slice(0, 300),
    });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "default";
    return env.RUNNER.get(env.RUNNER.idFromName(name)).fetch(request);
  },
};
