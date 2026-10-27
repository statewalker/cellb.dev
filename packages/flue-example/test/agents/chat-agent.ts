import { Agent, type Connection, type ConnectionContext, routeAgentRequest } from "agents";

// A minimal Agents SDK app: each socket says who it is when it connects, and every message
// goes to every socket (partyserver keeps the sender's state in the socket's attachment).
export class ChatAgent extends Agent<Record<string, unknown>> {
  onConnect(connection: Connection<{ user: string }>, ctx: ConnectionContext) {
    const user = new URL(ctx.request.url).searchParams.get("user") ?? "anon";
    connection.setState({ user });
    connection.send(`welcome ${user}`);
  }
  onMessage(connection: Connection<{ user: string }>, message: string | ArrayBuffer) {
    this.broadcast(`${connection.state?.user}: ${String(message)}`);
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
};
