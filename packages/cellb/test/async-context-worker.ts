/**
 * A Worker that reads one AsyncLocalStorage store across every kind of continuation, in many
 * Durable Objects at once. Run on Node (the real node:async_hooks) and in a browser (cellb's
 * polyfill), it must answer the same: each object sees its own store everywhere, and the Worker's
 * fetch, outside any run(), sees none. The object it calls sees the CALLER's store: cellb starts a
 * called object's event in the caller's async context (both run in one realm). On Cloudflare that
 * event starts with no store; docs/gaps.md has the difference.
 */
export const ASYNC_CONTEXT_WORKER = `
import { DurableObject, env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.random() * 8);
async function* ticks() { yield 1; await jitter(); yield 2; }
export class Probe extends DurableObject {
  async check(name) {
    return als.run(name, async () => {
      const seen = { sync: als.getStore() };
      await null;
      seen.afterAwait = als.getStore();
      await jitter();
      seen.afterTimer = als.getStore();
      await new Promise((r) => setTimeout(() => { seen.inTimeout = als.getStore(); r(); }, 1));
      await new Promise((r) => queueMicrotask(() => { seen.inMicrotask = als.getStore(); r(); }));
      seen.inThen = await Promise.resolve().then(() => als.getStore());
      seen.calleeSees = await env.PEER.getByName(name).ping();
      seen.afterRpc = als.getStore();
      for await (const _ of ticks()) seen.inForAwait = als.getStore();
      [seen.inAll] = await Promise.all([jitter().then(() => als.getStore())]);
      seen.nested = await als.run(name + "/inner", async () => { await jitter(); return als.getStore(); });
      seen.afterNested = als.getStore();
      try { await Promise.reject(new Error("x")); } catch { seen.afterCatch = als.getStore(); }
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
      this.ctx.storage.sql.exec("INSERT INTO t VALUES (?)", name);
      await jitter();
      seen.afterStorage = als.getStore();
      return seen;
    });
  }
}
export class Peer extends DurableObject {
  async ping() { await jitter(); return als.getStore() ?? null; }
}
export default {
  async fetch() {
    const names = Array.from({ length: 16 }, (_, i) => "c" + i);
    const results = await Promise.all(names.map((n) => env.PROBE.getByName(n).check(n)));
    return Response.json({
      outside: als.getStore() ?? null,
      results: Object.fromEntries(names.map((n, i) => [n, results[i]])),
    });
  },
};
`;

export const ASYNC_CONTEXT_CONFIG = {
  name: "async-context",
  main: "index.js",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { name: "PROBE", class_name: "Probe" },
      { name: "PEER", class_name: "Peer" },
    ],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["Probe", "Peer"] }],
};

/** What each object sees: its own name everywhere (the callee too), except inside the nested run. */
export function expectedSeen(name: string) {
  return {
    sync: name,
    afterAwait: name,
    afterTimer: name,
    inTimeout: name,
    inMicrotask: name,
    inThen: name,
    calleeSees: name, // Cloudflare: null (docs/gaps.md)
    afterRpc: name,
    inForAwait: name,
    inAll: name,
    nested: `${name}/inner`,
    afterNested: name,
    afterCatch: name,
    afterStorage: name,
  };
}
