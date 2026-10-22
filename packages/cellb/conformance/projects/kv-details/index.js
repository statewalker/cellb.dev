// KV limits and validation as celld enforces them.
const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 140)}`;
  }
};

export default {
  async fetch(request, env) {
    const KV = env.KV;
    return Response.json({
      emptyKey: await tryIt(() => KV.put("", "v")),
      dotKey: await tryIt(() => KV.put(".", "v")),
      longKey: await tryIt(() => KV.put("k".repeat(513), "v")),
      maxKey: await tryIt(() => KV.put("k".repeat(512), "v")),
      bigMeta: await tryIt(() => KV.put("m", "v", { metadata: { x: "y".repeat(1100) } })),
      shortTtl: await tryIt(() => KV.put("t", "v", { expirationTtl: 30 })),
      pastExpiration: await tryIt(() => KV.put("t", "v", { expiration: 1 })),
      cacheTtl: await tryIt(() => KV.get("maxKey", { cacheTtl: 10 })),
      listLimit: await tryIt(async () => (await KV.list({ limit: 1001 })).keys.length),
      bulkTooMany: await tryIt(() => KV.get(Array.from({ length: 101 }, (_, i) => `k${i}`))),
      bulkBadType: await tryIt(() => KV.get(["a"], "arrayBuffer")),
      getMissingWithMeta: await tryIt(() => KV.getWithMetadata("nope")),
      deleteMissing: await tryIt(() => KV.delete("nope")),
    });
  },
};
