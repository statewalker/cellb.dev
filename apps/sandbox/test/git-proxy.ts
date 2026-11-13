// The git proxy Worker on cellb in Node, in front of a local git server: the history pushed
// through it (as a browser would push to GitHub through a deployed proxy), read back by git.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { openHistory } from "../src/sandbox/history";
import { startGitServer } from "./git-server.mjs";

const enc = (s: string) => new TextEncoder().encode(s);
const srv = await startGitServer();
const upstream = new URL(srv.create("proxied.git"));
// The proxy project with this test's vars (the local git server's host, over http).
const dir = fileURLToPath(new URL("../git-proxy/", import.meta.url));
const project = new MemFilesApi();
await project.write("/src/worker.ts", [await readFile(`${dir}src/worker.ts`)]);
await project.write("/wrangler.json", [
  enc(
    JSON.stringify({
      name: "cellb-git-proxy",
      main: "src/worker.ts",
      compatibility_date: "2026-10-01",
      vars: {
        ALLOWED_HOSTS: upstream.host,
        ALLOW_HTTP: "1",
        ALLOWED_ORIGINS: "http://allowed.test",
      },
    }),
  ),
]);
const proxy = await loadProject(project);
// The proxy as an HTTP server (what `wrangler deploy` gives it).
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const r = await proxy.fetch(
    new Request(`http://proxy${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    }),
  );
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const port = (http.address() as { port: number }).port;
try {
  const remote = `http://127.0.0.1:${port}/${upstream.host}${upstream.pathname}`;
  // Refused: a host not allowed, an origin not allowed, a path that is not git.
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/evil.example/x.git/info/refs?service=git-upload-pack`))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(`${remote}/info/refs?service=git-upload-pack`, {
        headers: { origin: "http://other.test" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/${upstream.host}/etc/passwd`)).status, 404);
  const pre = await fetch(`${remote}/info/refs?service=git-receive-pack`, {
    method: "OPTIONS",
    headers: { origin: "http://allowed.test" },
  });
  assert.equal(pre.headers.get("access-control-allow-origin"), "http://allowed.test");

  const fs = new MemFilesApi();
  await fs.write("/README.md", [enc("# through the proxy\n")]);
  const h = await openHistory(fs);
  await h.commitAll("via proxy");
  const p = await h.push(remote);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(srv.git("proxied.git", "log", "--format=%s", "main").trim(), "via proxy");
  console.log("git-proxy: all good");
} finally {
  http.close();
  await proxy.close();
  await srv.close();
}
process.exit(0);
