// A plain node:http server: the same file runs in Docker on celld and in wasmer/edgejs on cellb.
const http = require("node:http");

http
  .createServer((req, res) => {
    const body = JSON.stringify({
      node: process.version,
      platform: process.platform,
      url: req.url,
      cell: process.env.CELL ?? null,
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  })
  .listen(8080, "0.0.0.0");
