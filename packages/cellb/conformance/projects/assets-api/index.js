// Static assets with a Worker: run_worker_first routes, ASSETS binding, fall-through.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return Response.json({ worker: url.pathname });
    if (url.pathname === "/via-binding") {
      const res = await env.ASSETS.fetch(new Request(new URL("/about", url), request));
      return new Response(`binding:${res.status}:${(await res.text()).trim()}`);
    }
    return new Response(`worker fallback ${request.method} ${url.pathname}`, { status: 299 });
  },
};
