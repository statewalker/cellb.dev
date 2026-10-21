// Workflow semantics that celld and webrun-cells must share: replayed steps, sleep,
// waitForEvent + sendEvent (also buffered before the wait), retries, errors, controls.
import { WorkflowEntrypoint } from "cloudflare:workers";

let replays = 0;

export class Flow extends WorkflowEntrypoint {
  async run(event, step) {
    replays++;
    const kind = event.payload.kind;
    if (kind === "steps") {
      const a = await step.do("a", async () => 1);
      await step.sleep("nap", "1 second");
      const b = await step.do("b", async () => a + 1);
      return { a, b };
    }
    if (kind === "event") {
      const e = await step.waitForEvent("approval", { type: "approve", timeout: "1 minute" });
      return { approved: e.payload, type: e.type };
    }
    if (kind === "retry") {
      return await step.do("flaky", { retries: { limit: 2, delay: "500 milliseconds", backoff: "constant" } }, async () => {
        throw new Error("always fails");
      });
    }
    if (kind === "retry2") {
      let attempt = 0;
      return await step.do("flaky2", { retries: { limit: 2, delay: 200, backoff: "constant" } }, async () => {
        attempt++;
        throw new Error("always fails");
      });
    }
    if (kind === "fail") throw new TypeError("bad input");
    if (kind === "long") {
      await step.sleep("long nap", "1 hour");
      return "woke";
    }
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const op = url.pathname.slice(1);
    if (op === "create") {
      const i = await env.FLOW.create({ id, params: { kind: url.searchParams.get("kind") } });
      return Response.json({ id: i.id });
    }
    if (op === "delete-batch") {
      const ids = url.searchParams.get("ids").split(",");
      const r = await env.FLOW.deleteBatch(ids);
      const left = [];
      for (const x of ids) left.push(await env.FLOW.get(x).then(() => "exists", (e) => e.message));
      return Response.json({ result: r ?? null, left });
    }
    const i = await env.FLOW.get(id);
    if (op === "delete") {
      await i.delete();
      return Response.json({ after: await env.FLOW.get(id).then(() => "exists", (e) => e.message) });
    }
    if (op === "status") return Response.json(await i.status());
    if (op === "event") {
      await i.sendEvent({ type: "approve", payload: { by: "ada" } });
      return Response.json({ sent: true });
    }
    if (op === "pause") await i.pause();
    if (op === "resume") await i.resume();
    if (op === "terminate") await i.terminate();
    return Response.json({ op, status: (await i.status()).status });
  },
};
