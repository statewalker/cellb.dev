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
    // Multipart: a 5 MiB part (the minimum but for the last) and a tail, then its metadata.
    if (url.pathname === "/mp") {
      const u = await env.B.createMultipartUpload(key, {
        httpMetadata: { contentType: "text/x-big" },
        customMetadata: { Who: url.searchParams.get("who") },
      });
      const parts = [await u.uploadPart(1, "x".repeat(5 * 1024 * 1024)), await u.uploadPart(2, key)];
      await u.complete(parts);
      return Response.json({ mp: key });
    }
    if (url.pathname === "/mp-get") {
      const o = await env.B.get(key);
      if (!o) return Response.json(null);
      const body = await o.text();
      return Response.json({
        size: o.size,
        tail: body.slice(-key.length),
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        md5: o.checksums.md5 ? [...new Uint8Array(o.checksums.md5)].map((b) => b.toString(16).padStart(2, "0")).join("") : null,
      });
    }
    if (url.pathname === "/list") return Response.json((await env.B.list()).objects.map((o) => o.key));
    return new Response("?", { status: 404 });
  },
};
