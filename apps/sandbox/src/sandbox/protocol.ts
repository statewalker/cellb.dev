// The page ↔ runner worker messages (the runner's own; site-host messages share the channel).

export type ToRunner =
  | { type: "run"; files: [string, Uint8Array][]; folderName: string }
  | { type: "stop" }
  /** A deployable folder of the project: a no_bundle Worker with the client as its assets. */
  | { type: "build"; id: number; files: [string, Uint8Array][]; folderName: string };

export type FromRunner =
  | { type: "phase"; phase: "idle" | "building" | "stopped" }
  | { type: "log"; text: string; level: "info" | "error" }
  | { type: "running"; baseUrl: string; name: string; server: boolean; client: boolean }
  | { type: "failed"; error: string }
  | { type: "built"; id: number; files: [string, Uint8Array][]; summary: string }
  | { type: "build-failed"; id: number; error: string };
