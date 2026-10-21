import type { FilesApi } from "@statewalker/webrun-files";

/**
 * The "disk directory service" that Miniflare's simulators expect behind their
 * `MINIFLARE_BLOBS` service binding (workerd provides it from a local directory),
 * implemented on a webrun-files FilesApi: OPFS in a browser, S3, memory, node fs…
 *
 * Protocol (as used by Miniflare's BlobStore): `PUT /<path>` stores the body,
 * `GET /<path>` returns it (404 if absent) honouring a single `Range: bytes=a-b`,
 * `HEAD /<path>` returns Content-Length, `DELETE /<path>` removes it.
 */
export function filesApiBlobService(
  files: FilesApi,
  root = "/blobs",
): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
  const pathOf = (url: URL) => `${root}${decodeURIComponent(url.pathname)}`;
  const readAll = async (path: string): Promise<Uint8Array | undefined> => {
    if (!(await files.exists(path))) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of files.read(path)) chunks.push(c);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  };
  return {
    async fetch(input, init) {
      // Not `new Request(input, init)`: workerd code sends stream bodies without
      // `duplex: "half"`, which browsers and Node reject when building a Request.
      const src = input instanceof Request ? input : undefined;
      const url = new URL(src ? src.url : String(input));
      const method = (init?.method ?? src?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers ?? src?.headers);
      const path = pathOf(url);
      if (method === "PUT") {
        const body = init?.body ?? src?.body ?? null;
        await files.write(path, [new Uint8Array(await new Response(body).arrayBuffer())]);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        await files.remove(path);
        return new Response(null, { status: 204 });
      }
      const data = await readAll(path);
      if (!data) return new Response(null, { status: 404 });
      if (method === "HEAD")
        return new Response(null, { headers: { "Content-Length": String(data.byteLength) } });
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") ?? "");
      if (range) {
        const [start, end] = [Number(range[1]), Math.min(Number(range[2]), data.byteLength - 1)];
        return new Response(data.slice(start, end + 1) as BodyInit, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${data.byteLength}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }
      return new Response(data as BodyInit, {
        headers: { "Content-Length": String(data.byteLength) },
      });
    },
  };
}
