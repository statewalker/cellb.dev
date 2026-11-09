// Serves a wrangler project (source or built folder) on cellb in Node over HTTP:
//   tsx scripts/serve-cellb.mjs <project dir> [--port 8793] [--data <dir>]
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { loadProject } from "@statewalker/cellb/node";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const dir = resolve(args[0]);
const port = Number(opt("port", 8793));
const data = opt("data");
if (data) mkdirSync(data, { recursive: true });
const project = await loadProject(dir, data ? { data: resolve(data) } : {});
if (project.unsupported?.length) console.error("[cellb] unsupported:", project.unsupported);

createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [],
      ),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    const response = await project.fetch(request);
    const headers = {};
    response.headers.forEach((v, k) => {
      if (k === "set-cookie") return;
      headers[k] = v;
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.stack ?? e));
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`cellb (Node) serving ${dir} on http://127.0.0.1:${port}`),
);

const stop = async () => {
  await project.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
