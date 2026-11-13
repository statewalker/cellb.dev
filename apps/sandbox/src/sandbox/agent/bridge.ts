// Publishing the sandbox's tools to agents outside the page's own code.
//
//   window.cellbSandbox      a script API: `tools` (specs), `call(name, args)`. What a
//                            browser-driving agent (Playwright, a browser extension, a computer-use
//                            model with devtools) calls instead of clicking.
//   navigator.modelContext   WebMCP, where the browser has it: each tool registered with the
//                            page, so an agent built into the browser can call it.
//   <origin>/<id>/mcp        an MCP endpoint (Streamable HTTP, stateless) hosted by the page's
//                            ServiceWorker: any code running in a tab of this origin, the
//                            running app itself included, can speak MCP to its own IDE.
//
// Agents that are not in this browser reach the same handler through an ingress the person
// chooses: an HTTPeers mount (`mounts.provide("/mcp", handler)`, Biscuit-guarded), see
// docs/architecture.md.

import { SwHttpAdapter } from "@statewalker/webrun-http-browser";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { createMcpHandler } from "./mcp";
import { callTool, specsOf, type Tool } from "./tools";

export interface PublishedTools {
  /** The MCP endpoint's URL, once the ServiceWorker hosts it. */
  mcpUrl?: string;
  /** True when the tools were registered with WebMCP. */
  webmcp: boolean;
  dispose(): Promise<void>;
}

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
  execute(input: Record<string, unknown>): Promise<unknown>;
};

type ModelContext = {
  registerTool?(tool: ModelContextTool): { unregister?(): void } | undefined;
  unregisterTool?(name: string): void;
  provideContext?(ctx: { tools: ModelContextTool[] }): void;
};

function toWebMcp(tool: Tool, tools: () => Tool[]): ModelContextTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: !!tool.readOnly },
    async execute(input) {
      const out = await callTool(tools(), tool.name, input ?? {});
      return {
        content: [{ type: "text", text: out.ok ? JSON.stringify(out.result, null, 2) : out.error }],
        isError: !out.ok,
      };
    },
  };
}

/** Registers the tools with WebMCP; returns how to take them back, or undefined without it. */
function registerWebMcp(tools: () => Tool[]): (() => void) | undefined {
  const mc = (navigator as unknown as { modelContext?: ModelContext }).modelContext;
  if (!mc) return undefined;
  const list = tools().map((t) => toWebMcp(t, tools));
  if (typeof mc.registerTool === "function") {
    const handles = list.map((t) => mc.registerTool?.(t));
    return () => {
      handles.forEach((h, i) => {
        if (h?.unregister) h.unregister();
        else mc.unregisterTool?.(list[i].name);
      });
    };
  }
  if (typeof mc.provideContext === "function") {
    mc.provideContext({ tools: list });
    return () => mc.provideContext?.({ tools: [] });
  }
  return undefined;
}

export interface CellbSandboxApi {
  version: 1;
  tools: ReturnType<typeof specsOf>;
  call(name: string, args?: Record<string, unknown>): ReturnType<typeof callTool>;
  mcpUrl?: string;
}

export async function publishTools(
  tools: () => Tool[],
  opts: { serviceWorkerUrl?: string } = {},
): Promise<PublishedTools> {
  const api: CellbSandboxApi = {
    version: 1,
    tools: specsOf(tools()),
    call: (name, args) => callTool(tools(), name, args ?? {}),
  };
  (globalThis as { cellbSandbox?: CellbSandboxApi }).cellbSandbox = api;
  const unregister = registerWebMcp(tools);

  let site: { baseUrl: string; stop(): Promise<void> } | undefined;
  try {
    const mcp = createMcpHandler(tools);
    const builder = new HostedSiteBuilder({
      adapterFactory: ({ key, serviceWorkerUrl }) => new SwHttpAdapter({ key, serviceWorkerUrl }),
    }).setHandler(async (request: Request) => {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      if (path.endsWith("/mcp")) return mcp(request);
      return new Response(
        JSON.stringify({ mcp: "mcp", tools: specsOf(tools()).map((t) => t.name) }),
        { headers: { "content-type": "application/json" } },
      );
    });
    if (opts.serviceWorkerUrl) builder.setServiceWorkerUrl(opts.serviceWorkerUrl);
    site = await builder.build();
    api.mcpUrl = `${site.baseUrl.replace(/\/?$/, "/")}mcp`;
  } catch (err) {
    console.warn("cellb sandbox: the MCP endpoint is not hosted:", err);
  }
  return {
    mcpUrl: api.mcpUrl,
    webmcp: !!unregister,
    async dispose() {
      unregister?.();
      await site?.stop().catch(() => {});
      const g = globalThis as { cellbSandbox?: CellbSandboxApi };
      if (g.cellbSandbox === api) delete g.cellbSandbox;
    },
  };
}
