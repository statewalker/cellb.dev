// A Cloudflare Agents SDK app run by cellb in a browser (e2e-browser/agents-sdk.spec.ts).
import { Agent, getCurrentAgent, routeAgentRequest } from "agents";

export class Echo extends Agent {
  async onRequest() {
    // Another agent's event runs during this wait; afterwards this one must still be current.
    await new Promise((r) => setTimeout(r, 50));
    return Response.json({ name: this.name, current: getCurrentAgent().agent?.name });
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/context") {
      // Two agents answer at once in this realm.
      const answers = await Promise.all(
        ["a", "b"].map(async (name) =>
          (await routeAgentRequest(new Request(`http://app/agents/echo/${name}`), env)).json(),
        ),
      );
      return Response.json(answers);
    }
    // /agents/echo/<name>: HTTP and WebSocket connections to an agent.
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
};
