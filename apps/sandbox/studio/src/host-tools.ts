// Tools the host gives the agent beyond files: running and testing the app. The studio cannot
// run the app itself (the host owns the folder and the runner), so each call goes to the host,
// which first applies what the agent wrote to its folder (Workspace.changes), then acts.
//
// The host is found at `globalThis.cellbStudioHost`: the sandbox's runner sets it in the realm
// where CellB runs this Worker. Elsewhere (wrangler, celld, Node) there is none, and the agent
// has only its file tools.

import { Type } from "typebox";

export interface StudioHost {
  call(
    tool: "run_app" | "read_logs" | "http_request",
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

export function studioHost(): StudioHost | undefined {
  const h = (globalThis as { cellbStudioHost?: StudioHost }).cellbStudioHost;
  return h && typeof h.call === "function" ? h : undefined;
}

const MAX = 12_000;

function tool(
  host: StudioHost,
  name: "run_app" | "read_logs" | "http_request",
  label: string,
  description: string,
  parameters: ReturnType<typeof Type.Object>,
) {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      const out = await host.call(name, params ?? {});
      if (!out.ok) throw new Error(out.error);
      const text = JSON.stringify(out.result, null, 2);
      return {
        content: [
          { type: "text", text: text.length > MAX ? `${text.slice(0, MAX)}… [cut]` : text },
        ],
        details: undefined,
      };
    },
  };
}

export function hostTools(host: StudioHost) {
  return [
    tool(
      host,
      "run_app",
      "Run the app",
      "Builds and (re)starts the project's app (server on CellB, client compiled) with your latest changes, waits until it runs or fails, and returns its state and this run's log (bundling errors included). Call it when a change is complete.",
      Type.Object({}),
    ),
    tool(
      host,
      "read_logs",
      "Read the log",
      "Reads the app's log: builds, server errors, client modules that fail to compile, and the Worker's console output. `since` (a line id) returns newer lines only; `errors_only` keeps errors.",
      Type.Object({
        since: Type.Optional(Type.Number()),
        errors_only: Type.Optional(Type.Boolean()),
      }),
    ),
    tool(
      host,
      "http_request",
      "Call the app",
      "Sends an HTTP request to the running app as its client would (relative path such as `api/items`). Returns status, headers and body.",
      Type.Object({
        path: Type.String(),
        method: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        body: Type.Optional(Type.String()),
      }),
    ),
  ];
}
