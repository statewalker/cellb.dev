// An alarm whose handler fails twice, then succeeds: the retry count lives in the alarm's
// storage row, so it continues wherever the cell runs next.
import { DurableObject } from "cloudflare:workers";

export class Flaky extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/arm") {
      await this.ctx.storage.setAlarm(Date.now() + Number(url.searchParams.get("in") ?? 500));
      return Response.json({ armed: true });
    }
    return Response.json({
      attempts: (await this.ctx.storage.get("attempts")) ?? [],
      done: (await this.ctx.storage.get("done")) ?? null,
      pending: (await this.ctx.storage.getAlarm()) !== null,
    });
  }
  async alarm(info) {
    const attempts = (await this.ctx.storage.get("attempts")) ?? [];
    attempts.push(info.retryCount);
    await this.ctx.storage.put("attempts", attempts);
    if (info.retryCount < 2) throw new Error(`attempt ${info.retryCount} fails`);
    await this.ctx.storage.put("done", { retryCount: info.retryCount, isRetry: info.isRetry });
  }
}

export default {
  fetch(request, env) {
    return env.A.getByName("f").fetch(request);
  },
};
