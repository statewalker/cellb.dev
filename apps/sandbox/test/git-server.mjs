// A smart-HTTP git server for tests: `git http-backend` (CGI) behind node:http, with CORS
// headers (what a proxy Worker adds in front of GitHub), over bare repositories in a temp dir.
//   const srv = await startGitServer(); srv.url("demo.git"); await srv.close();
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startGitServer() {
  const root = await mkdtemp(join(tmpdir(), "git-server-"));
  const backend = join(
    execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
    "git-http-backend",
  );
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, git-protocol, accept",
      "access-control-expose-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url, "http://x");
    const cgi = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
        REMOTE_USER: "tester",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const chunks = [];
    cgi.stdout.on("data", (c) => chunks.push(c));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, split).toString();
      const body = out.subarray(split + 4);
      let status = 200;
      const headers = { ...cors };
      for (const line of head.split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = Number(v.split(" ")[0]);
        else if (k) headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    root,
    /** Creates a bare repository that accepts pushes; returns its URL. */
    create(name) {
      const dir = join(root, name);
      execFileSync("git", ["init", "--bare", "-q", "-b", "main", dir]);
      execFileSync("git", ["-C", dir, "config", "http.receivepack", "true"]);
      return `http://127.0.0.1:${port}/${name}`;
    },
    git: (name, ...args) =>
      execFileSync("git", ["-C", join(root, name), ...args], { encoding: "utf8" }),
    close: () => new Promise((r) => server.close(r)),
  };
}
