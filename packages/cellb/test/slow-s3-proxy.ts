import { createServer, request, type Server } from "node:http";

/**
 * An HTTP proxy in front of an S3 endpoint that delays the PUTs of cell log files (keys with
 * `/ltx/`) by `delayMs`, one at a time: a bucket slower than a node's log tier followers. Requests
 * cross unchanged (the Host header too), so SigV4 signatures made for the proxy's address hold.
 */
export async function slowS3Proxy(target: string, delayMs: number) {
  const t = new URL(target);
  const server: Server = createServer((req, res) => {
    const forward = () => {
      const up = request(
        { host: t.hostname, port: t.port, method: req.method, path: req.url, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    };
    if (req.method === "PUT" && req.url?.includes("/ltx/")) setTimeout(forward, delayMs);
    else forward();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
