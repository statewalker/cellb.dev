// The page ↔ runner worker messages (the runner's own; site-host messages share the channel).
//
// The runner reads a project's files through a capability: a read-only Biscuit token the page
// gives with each run or build, checked by the studio (over the port `studio-port` gives).

export type ToRunner =
  /** The runner's link to the studio (its HTTP, served over this port by the studio worker). */
  | { type: "studio-port"; port: MessagePort }
  | { type: "run"; workspace: string; token: string; folderName: string }
  | { type: "stop" }
  /** A deployable folder of the project: a no_bundle Worker with the client as its assets. */
  | {
      type: "build";
      id: number;
      workspace: string;
      token: string;
      folderName: string;
      /** The preview's Durable Object data in the folder too (`.cellb-data/`). */
      withData?: boolean;
    };

export type FromRunner =
  | { type: "phase"; phase: "idle" | "building" | "stopped" }
  | { type: "log"; text: string; level: "info" | "error" }
  | { type: "running"; baseUrl: string; name: string; server: boolean; client: boolean }
  | { type: "failed"; error: string }
  | { type: "built"; id: number; files: [string, Uint8Array][]; summary: string }
  | { type: "build-failed"; id: number; error: string };
