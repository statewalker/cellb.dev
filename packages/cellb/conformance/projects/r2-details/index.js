// R2 validation and edge cases as celld implements them.
const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 160)}`;
  }
};
export default {
  async fetch(request, env) {
    const B = env.B;
    return Response.json({
      emptyKey: await tryIt(() => B.put("", "x")),
      longKey: await tryIt(() => B.put("k".repeat(1025), "x")),
      maxKey: await tryIt(async () => (await B.put("k".repeat(1024), "x")).size),
      nullBody: await tryIt(async () => (await B.put("null", null)).size),
      bigMeta: await tryIt(() => B.put("m", "x", { customMetadata: { a: "b".repeat(3000) } })),
      headersMeta: await tryIt(async () => (await B.put("h", "x", { httpMetadata: new Headers({ "content-type": "text/x" }) })).httpMetadata),
      getMissing: await tryIt(() => B.get("missing")),
      headMissing: await tryIt(() => B.head("missing")),
      deleteMissing: await tryIt(() => B.delete("missing")),
      delete1001: await tryIt(() => B.delete(Array.from({ length: 1001 }, (_, i) => `d${i}`))),
      listLimit: await tryIt(async () => (await B.list({ limit: 2000 })).objects.length),
      listZero: await tryIt(async () => (await B.list({ limit: 0 })).objects.length),
      md5Mismatch: await tryIt(() => B.put("md5", "x", { md5: "00000000000000000000000000000000" })),
      uploadedType: await tryIt(async () => typeof (await B.head("h")).uploaded.getTime()),
    });
  },
};
