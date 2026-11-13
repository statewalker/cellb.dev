// The host seam, and the tools the host gives the agent beyond files: running and testing the app. The studio cannot
// run the app itself (the host owns the folder and the runner), so each call goes to the host,
// which first applies what the agent wrote to its folder (Workspace.changes), then acts.
//
// The host is found at `globalThis.cellbStudioHost`: the sandbox's runner sets it in the realm
// where CellB runs this Worker. Elsewhere (wrangler, celld, Node) there is none, and the agent
// has only its file tools.

import type { FilesApi } from "@statewalker/webrun-files";
import { Type } from "typebox";

/**
 * What the host gives the studio, at `globalThis.cellbStudioHost` (the sandbox's studio worker
 * sets it; a server deployment may set it, or not):
 *   store(ws)   the FilesApi a workspace's capabilities filter (the folder on disk, memory, OPFS,
 *               S3, a composite…); without it the Workspace keeps files in its own SQLite
 *   notify      what a write through a capability changed (the host refreshes its views)
 *   call        the agent's host tools: run the app, read its log, call it
 */
export interface StudioHost {
  call(
    tool: "run_app" | "read_logs" | "http_request",
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  store?(workspace: string): FilesApi | undefined;
  /** Runs Python (Pyodide) on a copy of files; reports what changed (python-tool.ts). */
  python?(req: { files: [string, Uint8Array][]; code: string; cwd?: string }): Promise<PythonOut>;
  /** Runs a Wasmer registry command on a copy of files; reports what changed (wasmer-tool.ts). */
  wasmer?(req: WasmerReq): Promise<WasmerOut>;
  notify?(workspace: string, path: string, kind: "write" | "delete" | "mkdir"): void;
}

export interface PythonOut {
  stdout: string;
  stderr: string;
  value: string | null;
  error?: string;
  changes: [string, Uint8Array | null][];
}

export interface WasmerReq {
  files: [string, Uint8Array][];
  packages: string[];
  command: string;
  args: string[];
  stdin?: string;
  cwd?: string;
}

export interface WasmerOut {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  changes: [string, Uint8Array | null][];
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
