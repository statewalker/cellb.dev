// The page ↔ runner worker messages (the runner's own; site-host messages share the channel).

export type ToRunner =
  | { type: "run"; files: [string, Uint8Array][]; folderName: string }
  | { type: "stop" };

export type FromRunner =
  | { type: "phase"; phase: "idle" | "building" | "stopped" }
  | { type: "log"; text: string; level: "info" | "error" }
  | { type: "running"; baseUrl: string; name: string; server: boolean; client: boolean }
  | { type: "failed"; error: string };
