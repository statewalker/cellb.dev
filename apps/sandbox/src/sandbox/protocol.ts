// The page ↔ runner worker messages (the runner's own; site-host messages share the channel).

export type ToRunner =
  | { type: "run"; files: [string, Uint8Array][]; folderName: string }
  | { type: "stop" }
  /** A deployable folder of the project: a no_bundle Worker with the client as its assets. */
  | { type: "build"; id: number; files: [string, Uint8Array][]; folderName: string }
  /** A request to the studio Worker (the agents' side: Workspace and Agent cells). */
  | {
      type: "studio";
      id: number;
      /** Where the studio's `cellb build` is served (<base>studio/). */
      studioUrl: string;
      path: string;
      method: string;
      headers: [string, string][];
      body?: string;
    }
  /** The page's answer to a host call the studio made (`host-call`). */
  | {
      type: "host-reply";
      id: number;
      out: { ok: true; result: unknown } | { ok: false; error: string };
    };

export type FromRunner =
  | { type: "phase"; phase: "idle" | "building" | "stopped" }
  | { type: "log"; text: string; level: "info" | "error" }
  | { type: "running"; baseUrl: string; name: string; server: boolean; client: boolean }
  | { type: "failed"; error: string }
  | { type: "built"; id: number; files: [string, Uint8Array][]; summary: string }
  | { type: "build-failed"; id: number; error: string }
  | { type: "studio-reply"; id: number; status: number; body: string }
  /** The studio's agent asks the page to act (run the app, read the log, call the app). */
  | {
      type: "host-call";
      id: number;
      tool: "run_app" | "read_logs" | "http_request";
      args: Record<string, unknown>;
    };
