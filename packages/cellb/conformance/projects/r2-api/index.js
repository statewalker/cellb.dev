// Exercises the R2 binding API and returns what it sees as JSON, so the same project can
// be compared between celld and webrun-cells (conformance/projects are ours, not celld's).
const view = (o) =>
  o && {
    key: o.key,
    size: o.size,
    etag: o.etag,
    httpEtag: o.httpEtag,
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
    range: o.range,
    uploadedIsDate: o.uploaded instanceof Date,
    versionIsString: typeof o.version === "string",
  };

export default {
  async fetch(request, env) {
    const step = new URL(request.url).pathname.slice(1);
    const B = env.B;
    switch (step) {
      case "put": {
        const a = await B.put("docs/a.txt", "alpha", {
          httpMetadata: { contentType: "text/plain", cacheControl: "max-age=60" },
          customMetadata: { owner: "ada" },
        });
        await B.put("docs/b.json", JSON.stringify({ b: 1 }), {
          httpMetadata: { contentType: "application/json" },
        });
        await B.put("docs/sub/c.bin", new Uint8Array([1, 2, 3, 4, 5]));
        await B.put("top.txt", "top");
        return Response.json(view(a));
      }
      case "head":
        return Response.json({
          a: view(await B.head("docs/a.txt")),
          missing: await B.head("nope"),
        });
      case "get": {
        const o = await B.get("docs/a.txt");
        const headers = new Headers();
        o.writeHttpMetadata(headers);
        return Response.json({
          ...view(o),
          text: await o.text(),
          headers: Object.fromEntries(headers),
        });
      }
      case "range": {
        const r1 = await B.get("docs/sub/c.bin", { range: { offset: 1, length: 2 } });
        const r2 = await B.get("docs/sub/c.bin", { range: { suffix: 2 } });
        return Response.json({
          r1: [...new Uint8Array(await r1.arrayBuffer())],
          r1range: r1.range,
          r2: [...new Uint8Array(await r2.arrayBuffer())],
          r2range: r2.range,
        });
      }
      case "json":
        return Response.json(await (await B.get("docs/b.json")).json());
      case "list": {
        const all = await B.list();
        const docs = await B.list({ prefix: "docs/", delimiter: "/" });
        const page = await B.list({ limit: 2 });
        const rest = await B.list({ limit: 2, cursor: page.cursor });
        const withMeta = await B.list({
          prefix: "docs/a",
          include: ["httpMetadata", "customMetadata"],
        });
        return Response.json({
          all: all.objects.map((o) => o.key),
          allTruncated: all.truncated,
          docs: docs.objects.map((o) => o.key),
          docsPrefixes: docs.delimitedPrefixes,
          page: page.objects.map((o) => o.key),
          pageTruncated: page.truncated,
          rest: rest.objects.map((o) => o.key),
          withMeta: withMeta.objects.map((o) => [o.key, o.httpMetadata, o.customMetadata]),
        });
      }
      case "delete": {
        await B.delete(["docs/b.json", "top.txt"]);
        await B.delete("docs/a.txt");
        return Response.json({
          left: (await B.list()).objects.map((o) => o.key),
          gone: await B.get("top.txt"),
        });
      }
      default:
        return new Response("unknown step", { status: 404 });
    }
  },
};
