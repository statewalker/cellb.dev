// The sandbox's tools as an MCP server: a `Request → Response` handler speaking MCP's Streamable
// HTTP transport in its stateless form (one JSON-RPC message or batch per POST, a JSON answer).
//
// A fetch handler fits every ingress the platform has: the page's ServiceWorker (same-origin
// tabs, browser-automation agents), an HTTPeers mount (`mounts.provide("/mcp", handler)`, for
// agents that are mesh members), a MessagePort bridge. The transport adds no authority of its own:
// whoever mounts it decides who reaches it (HTTPeers: a Biscuit rule such as
// `capability("studio:tools") <- role("owner")`).

import { callTool, type Tool } from "./tools";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface McpServerOptions {
  name?: string;
  version?: string;
  /** Text for the client: how to use the tools (MCP `instructions`). */
  instructions?: string;
  /** Hides tools that change something (a read-only share of the workspace). */
  readOnly?: boolean;
}

export const DEFAULT_INSTRUCTIONS =
  "Tools over a project open in CellB sandbox, a browser IDE. The project is a Cloudflare-Workers-style app: wrangler.jsonc + main is the server (Durable Objects run on CellB in the browser tab), client/index.html with TS/TSX scripts is the client, calling the server with relative URLs. Start with project_info and list_files, read AGENTS.md when present, change files with edit_file/write_file, then run_app and test with http_request; read_logs shows build and server errors.";

/** Handles one JSON-RPC message; undefined for a notification (no answer). */
export async function handleMcpMessage(
  tools: Tool[],
  msg: JsonRpcRequest,
  opts: McpServerOptions = {},
): Promise<JsonRpcResponse | undefined> {
  const id = msg.id ?? null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  const visible = opts.readOnly ? tools.filter((t) => t.readOnly) : tools;
  if (msg.id === undefined) return undefined; // notifications/initialized and friends
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion:
          typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.name ?? "cellb-sandbox", version: opts.version ?? "0.1.0" },
        instructions: opts.instructions ?? DEFAULT_INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: visible.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!visible.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
      const out = await callTool(
        visible,
        name,
        (msg.params?.arguments as Record<string, unknown>) ?? {},
      );
      return ok(
        out.ok
          ? {
              content: [{ type: "text", text: JSON.stringify(out.result, null, 2) }],
              structuredContent: out.result,
            }
          : { content: [{ type: "text", text: out.error }], isError: true },
      );
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
  });

/** The MCP endpoint as a fetch handler. */
export function createMcpHandler(
  tools: Tool[] | (() => Tool[]),
  opts: McpServerOptions = {},
): (request: Request) => Promise<Response> {
  const list = typeof tools === "function" ? tools : () => tools;
  return async (request) => {
    if (request.method === "GET" || request.method === "DELETE")
      // No server-initiated stream and no session to end: the stateless transport.
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
        400,
      );
    }
    const messages = Array.isArray(body) ? body : [body];
    const answers: JsonRpcResponse[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object" || typeof (m as JsonRpcRequest).method !== "string") {
        answers.push({
          jsonrpc: "2.0",
          id: (m as JsonRpcRequest)?.id ?? null,
          error: { code: -32600, message: "invalid request" },
        });
        continue;
      }
      const a = await handleMcpMessage(list(), m as JsonRpcRequest, opts);
      if (a) answers.push(a);
    }
    if (answers.length === 0) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? answers : answers[0]);
  };
}
