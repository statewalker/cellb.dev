import { DurableObject } from "cloudflare:workers";

// The fragment DO: calls gamma through its bindings, from Worker code.
export class Fragment extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/hello") return Response.json(await this.env.API.hello("delta"));
      if (url.pathname === "/count") return Response.json(await this.env.API.count());
      if (url.pathname === "/fetch") return this.env.GAMMA.fetch("http://gamma/p?q=1");
      if (url.pathname === "/upper")
        return new Response(await this.env.API.upper(new Response("one two").body));
      if (url.pathname === "/fail") return Response.json(await this.env.API.fail());
      if (url.pathname === "/function") return Response.json(await this.env.API.echo(() => 1));
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: { name: e.name, message: e.message } }, { status: 500 });
    }
  }
}

export default {
  fetch() {
    return new Response("delta");
  },
};
