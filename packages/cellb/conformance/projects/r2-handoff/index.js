// R2 objects written by one runtime and read by the other (same fleet bucket): bytes, HTTP
// metadata (headers and cacheExpiry), case-sensitive non-ASCII custom metadata, checksums,
// ranges and listing.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (url.pathname === "/put") {
      await env.B.put(key, url.searchParams.get("body"), {
        httpMetadata: {
          contentType: "text/x-note",
          contentLanguage: "fr",
          cacheExpiry: new Date(Date.UTC(2030, 0, 1)),
        },
        customMetadata: { Who: url.searchParams.get("who"), note: "déjà vu ✓" },
      });
      return Response.json({ put: key });
    }
    if (url.pathname === "/get") {
      const o = await env.B.get(key);
      if (!o) return Response.json(null);
      const part = await env.B.get(key, { range: { offset: 1, length: 3 } });
      return Response.json({
        body: await o.text(),
        size: o.size,
        httpMetadata: { ...o.httpMetadata, cacheExpiry: o.httpMetadata.cacheExpiry?.toISOString() ?? null },
        customMetadata: o.customMetadata,
        md5: [...new Uint8Array(o.checksums.md5 ?? new ArrayBuffer(0))].map((b) => b.toString(16).padStart(2, "0")).join(""),
        range: await part.text(),
      });
    }
    if (url.pathname === "/list") return Response.json((await env.B.list()).objects.map((o) => o.key));
    return new Response("?", { status: 404 });
  },
};
