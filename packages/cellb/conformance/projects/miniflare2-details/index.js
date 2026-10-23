// Durable Object behaviours Miniflare v2's storage and namespace tests covered and the other
// projects do not observe (cloudflare/miniflare@b536e56 packages/durable-objects/test/
// storage.spec.ts, namespace.spec.ts). Its assertions are not copied: celld's answers decide.
import { DurableObject } from "cloudflare:workers";

const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 150)}`;
  }
};
const entries = (m) => [...m.entries()];

export class Store extends DurableObject {
  async storage() {
    const s = this.ctx.storage;
    await s.put({ a: 1, b: 2, c: 3 });
    const opts = { start: "a", startAfter: "a", limit: 5 };
    const before = JSON.stringify(opts);
    const listed = await tryIt(async () => [...(await s.list(opts)).keys()]);
    return {
      getManyUndefinedKey: await tryIt(async () => entries(await s.get(["a", undefined]))),
      putManyUndefinedValue: await tryIt(async () => {
        await s.put({ x: 1, y: undefined });
        return String(await s.get("y"));
      }),
      deleteManyMissing: await s.delete(["a", "nope1", "nope2"]),
      listStartAndStartAfter: listed,
      listOptionsNotMutated: JSON.stringify(opts) === before,
      txnSeesUncommitted: await s.transaction(async (txn) => {
        await txn.put("t", "new");
        return txn.get("t");
      }),
      txnListIncludesNew: await s.transaction(async (txn) => {
        await txn.put("t2", 1);
        return [...(await txn.list({ prefix: "t" })).keys()];
      }),
      txnDeleteReportsNew: await s.transaction(async (txn) => {
        await txn.put("t3", 1);
        return txn.delete("t3");
      }),
      txnReturnValue: await s.transaction(async () => ({ ok: [1, 2] })),
      putThenDeleteAllSameTurn: await tryIt(async () => {
        const p1 = s.put("z", 1);
        const p2 = s.deleteAll();
        await Promise.all([p1, p2]);
        return String(await s.get("z"));
      }),
    };
  }
  fetch(request) {
    // /stub's nonResponse: a fetch handler that does not return a Response
    if (new URL(request.url).pathname === "/plain") return {};
    return new Response("ok", { headers: { "x-from": "object" } });
  }
}

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    if (op === "storage") return Response.json(await env.S.getByName(op).storage());
    const stub = env.S.getByName("stub");
    if (op === "stub-relative")
      return Response.json({ relativeUrl: await tryIt(async () => (await stub.fetch("/x")).status) });
    return Response.json({
      unknownProtocol: await tryIt(async () => (await stub.fetch("ftp://x/")).status),
      nonResponse: await tryIt(async () => (await stub.fetch("https://x/plain")).status),
      immutableHeaders: await tryIt(async () => {
        const res = await stub.fetch("https://x/");
        res.headers.set("x-more", "1");
        return res.headers.get("x-more");
      }),
    });
  },
};
