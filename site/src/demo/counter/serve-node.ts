// The same project on Node: cellb loads the folder (wrangler.jsonc and its main), keeps each
// object's SQLite under ./data, and node:http serves the runtime's (Request) => Response handler.
//   npx tsx serve-node.ts [project dir] [port]
import { createServer } from "node:http";
import { loadProject } from "@statewalker/cellb/node";

const project = await loadProject(process.argv[2] ?? "./project", { data: "./data" });
if (project.unsupported.length) console.warn("unsupported:", project.unsupported);

createServer(async (req, res) => {
  const response = await project.fetch(new Request(`http://localhost${req.url}`));
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies; // one header each, not merged
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(process.argv[3] ?? 8787));

// curl 'localhost:8787/?name=alice'  →  {"name":"alice","n":1}
