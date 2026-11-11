// The page ↔ studio worker messages. HTTP to the studio itself goes over MessagePorts
// (`connect`: serveHandlerOverPort ↔ linkOverPort), one for the page and one for the runner.
import type { SourceSpec } from "./sources";

export type HostTool = "run_app" | "read_logs" | "http_request";
export type HostOut = { ok: true; result: unknown } | { ok: false; error: string };

export type ToStudio =
  | { type: "init"; studioUrl: string }
  /** Opens a project's files for workspace `ws`: the FilesApi its capabilities will filter. */
  | { type: "mount"; id: number; ws: string; source: SourceSpec }
  | { type: "unmount"; ws: string }
  /** Serves the studio's HTTP over this port (to the page, or to the runner). */
  | { type: "connect"; port: MessagePort }
  | { type: "host-reply"; id: number; out: HostOut };

export type FromStudio =
  | { type: "mounted"; id: number; error?: string }
  /** A write through a capability changed something (the page refreshes its view). */
  | { type: "changed"; ws: string; path: string; kind: "write" | "delete" | "mkdir" }
  /** The studio's agent asks the page to act. */
  | { type: "host-call"; id: number; tool: HostTool; args: Record<string, unknown> }
  | { type: "log"; text: string; level: "info" | "error" };
