import type { CDPSession, Page } from "@playwright/test";

/**
 * JS heap per realm (the page, each worker and nested worker, the ServiceWorker), sampled with
 * the DevTools protocol: every worker target is attached (non-flattened sessions) and asked
 * for Runtime.getHeapUsage. Returns a stop() that answers the peak per target.
 */
export async function sampleHeaps(
  page: Page,
  everyMs = 10_000,
  log = (s: string) => console.log(s),
) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const sessions = new Map<string, { url: string; type: string }>(); // sessionId → target
  const pending = new Map<string, (v: unknown) => void>();
  let nextId = 1;
  cdp.on("Target.receivedMessageFromTarget", (e: { sessionId: string; message: string }) => {
    const m = JSON.parse(e.message);
    pending.get(`${e.sessionId}:${m.id}`)?.(m.result);
  });
  cdp.on(
    "Target.attachedToTarget",
    (e: { sessionId: string; targetInfo: { url: string; type: string } }) => {
      sessions.set(e.sessionId, { url: e.targetInfo.url, type: e.targetInfo.type });
    },
  );
  cdp.on("Target.detachedFromTarget", (e: { sessionId: string }) => sessions.delete(e.sessionId));
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  const ask = (sessionId: string, method: string) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(`${sessionId}:${id}`, resolve);
      void cdp
        .send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method }) })
        .catch(() => resolve(undefined));
      setTimeout(() => resolve(undefined), 3000);
    });
  const peak = new Map<string, number>();
  const name = (url: string) => url.replace(/^.*\/(__cellb\/)?/, "").split("?")[0] || "(page)";
  const tick = async () => {
    const page = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    const rows: [string, number][] = [["(host page)", page.usedSize]];
    for (const [sid, t] of sessions) {
      const r = await ask(sid, "Runtime.getHeapUsage");
      if (r?.usedSize !== undefined) rows.push([`${name(t.url)}#${sid.slice(-4)}`, r.usedSize]);
    }
    for (const [k, v] of rows) peak.set(k, Math.max(peak.get(k) ?? 0, v));
    const total = rows.reduce((n, [, v]) => n + v, 0);
    log(
      `[heap] total ${(total / 1e6).toFixed(0)} MB: ${rows
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k} ${(v / 1e6).toFixed(0)}`)
        .join(", ")}`,
    );
  };
  const timer = setInterval(() => void tick().catch(() => {}), everyMs);
  return {
    stop() {
      clearInterval(timer);
      return [...peak].sort((a, b) => b[1] - a[1]);
    },
  };
}
