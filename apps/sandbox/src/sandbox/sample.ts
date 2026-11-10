// The sample project (sample/tasks in this package), as files: the same folder you can open with
// "Open folder" after downloading it.
import { encode, type ProjectFiles } from "./project";

const raw = import.meta.glob("../../sample/tasks/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const SAMPLE_NAME = "tasks";

export function sampleFiles(): ProjectFiles {
  const files: ProjectFiles = new Map();
  for (const [path, text] of Object.entries(raw))
    files.set(path.slice("../../sample/tasks".length), encode(text));
  return files;
}
