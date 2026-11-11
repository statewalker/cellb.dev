// A CORS proxy for git's smart HTTP protocol. It forwards only what a git client sends:
//   GET  /<host>/<repo path>/info/refs?service=git-upload-pack|git-receive-pack
//   POST /<host>/<repo path>/git-upload-pack | git-receive-pack
// to https://<host>/<repo path>/…, for hosts in ALLOWED_HOSTS, and adds CORS headers for the
// origins in ALLOWED_ORIGINS. It keeps nothing: credentials (Authorization) pass through to the
// git host. ALLOW_HTTP="1" forwards over http (tests against a local git server only).

interface Env {
  ALLOWED_HOSTS?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_HTTP?: string;
}

const GIT_PATH = /^\/([^/]+)\/(.+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const FORWARDED = ["authorization", "content-type", "accept", "git-protocol", "content-encoding"];

function corsHeaders(request: Request, env: Env): Record<string, string> | undefined {
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
  if (!origin) return {};
  if (!allowed.includes("*") && !allowed.includes(origin)) return undefined;
  return {
    "access-control-allow-origin": allowed.includes("*") ? "*" : origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, git-protocol",
    "access-control-expose-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (!cors) return new Response("origin not allowed\n", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const m = GIT_PATH.exec(url.pathname);
    if (!m) return new Response("not a git smart-HTTP request\n", { status: 404, headers: cors });
    const [, host, repo, endpoint] = m;
    const hosts = (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!hosts.includes(host))
      return new Response(`host not allowed: ${host}\n`, { status: 403, headers: cors });
    if (endpoint === "info/refs" && !SERVICES.has(url.searchParams.get("service") ?? ""))
      return new Response("unknown service\n", { status: 400, headers: cors });
    if (endpoint !== "info/refs" && request.method !== "POST")
      return new Response("POST only\n", { status: 405, headers: cors });
    const scheme = env.ALLOW_HTTP === "1" ? "http" : "https";
    const target = `${scheme}://${host}/${repo}/${endpoint}${url.search}`;
    const headers = new Headers();
    for (const h of FORWARDED) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("user-agent", "git/2.43 (cellb-git-proxy)");
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      // Buffered: a streamed request body needs `duplex` support some runtimes lack.
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
    const out = new Headers(cors);
    for (const h of ["content-type", "cache-control", "www-authenticate"]) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
