import { DurableObject } from "cloudflare:workers";

// A cell that runs its container's script on every request and counts the runs in its storage:
// wherever the cell lives, the same image (cellb.containers.Runner) runs the same script.
export class Runner extends DurableObject {
  async fetch() {
    const c = this.ctx.container;
    if (!c.running) await c.start();
    const runs = ((await this.ctx.storage.get("runs")) ?? 0) + 1;
    await this.ctx.storage.put("runs", runs);
    const r = await c.exec(["bash", "/workspace/job.sh", String(runs)]);
    return Response.json({ runs, exitCode: r.exitCode, out: r.stdout.trim() });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).searchParams.get("cell") ?? "default";
    return env.RUNNER.get(env.RUNNER.idFromName(name)).fetch(request);
  },
};
