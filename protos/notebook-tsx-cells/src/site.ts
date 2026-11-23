// PROTOTYPE (statewalker/statewalker-root#236). Serves a built page: `dist/` files, and `/_m/` from
// the module server (notebook-kit's runtime and the libraries its cells use).
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import type { LocalBuiltinsServer } from "../../../packages/notebooks/src/builtins.ts";
import { MODULES_BASE } from "./modules.ts";

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

export function serveSite(distDir: string, modules?: LocalBuiltinsServer): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (modules && url.pathname.startsWith(MODULES_BASE)) {
      const r = await modules.fetch(new Request(url));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const path = join(distDir, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)));
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}
