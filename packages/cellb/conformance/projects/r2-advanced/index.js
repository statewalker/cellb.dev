// R2 conditional requests (onlyIf) and multipart uploads, compared with celld.
const view = (o) => (o === null ? null : { key: o.key, size: o.size, hasBody: "body" in o && o.body !== undefined });

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    const B = env.B;
    if (op === "conditional") {
      const first = await B.put("c.txt", "one");
      const etag = first.etag;
      const out = {};
      out.getMatch = view(await B.get("c.txt", { onlyIf: { etagMatches: etag } }));
      const miss = await B.get("c.txt", { onlyIf: { etagMatches: "nope" } });
      out.getMissIsObjectWithoutBody = miss !== null && !("body" in miss && miss.body);
      out.getNoneMatch = view(await B.get("c.txt", { onlyIf: { etagDoesNotMatch: etag } })) !== null;
      out.putRefused = await B.put("c.txt", "two", { onlyIf: { etagMatches: "nope" } });
      out.putAccepted = view(await B.put("c.txt", "three", { onlyIf: { etagMatches: etag } }));
      out.text = await (await B.get("c.txt")).text();
      out.uploadedBefore = (await B.put("c.txt", "four", { onlyIf: { uploadedBefore: new Date(0) } })) === null;
      return Response.json(out);
    }
    if (op === "multipart") {
      const up = await B.createMultipartUpload("big.bin", { httpMetadata: { contentType: "application/x-test" } });
      const part1 = await up.uploadPart(1, "a".repeat(5 * 1024 * 1024));
      const part2 = await up.uploadPart(2, "bc");
      const resumed = B.resumeMultipartUpload("big.bin", up.uploadId);
      const obj = await resumed.complete([part1, part2]);
      const got = await B.get("big.bin");
      const text = await got.text();
      const aborted = await B.createMultipartUpload("gone.bin");
      await aborted.uploadPart(1, "x");
      await aborted.abort();
      return Response.json({
        key: obj.key,
        size: obj.size,
        type: got.httpMetadata.contentType,
        tail: text.slice(-4),
        length: text.length,
        partNumbers: [part1.partNumber, part2.partNumber],
        abortedGone: (await B.head("gone.bin")) === null,
      });
    }
    return new Response("unknown op", { status: 404 });
  },
};
