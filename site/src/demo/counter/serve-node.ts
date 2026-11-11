// The same project on Node: CellB loads the folder (wrangler.jsonc and its main) and keeps each
// object's SQLite under ./data; node:http hands each request to project.fetch(Request).
//   npx tsx serve-node.ts [project dir] [port]
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { loadProject } from "@statewalker/cellb/node";

const project = await loadProject(process.argv[2] ?? "./project", { data: "./data" });
if (project.unsupported.length) console.warn("unsupported:", project.unsupported);

createServer(async (req, res) => {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await buffer(req);
  const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body });
  const response = await project.fetch(request);
  const out: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies; // one header each, not merged
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(process.argv[3] ?? 8787));

// curl 'localhost:8787/?name=alice'  →  {"name":"alice","n":1}
