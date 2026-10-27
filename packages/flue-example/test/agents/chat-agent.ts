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
    // Under a router that keeps its base path (cellb's installProjectRouter), the agents live
    // at <AGENTS_PREFIX>/<agent>/<name>, e.g. app/<project>/agents/chat-agent/room-1.
    const prefix = (env.AGENTS_PREFIX as string | undefined) ?? "agents";
    const res = await routeAgentRequest(request, env, { prefix });
    return res ?? new Response("not found", { status: 404 });
  },
};
