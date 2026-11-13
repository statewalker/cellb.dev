// The sample project (sample/tasks in this package), as files: the same folder you can open with
// "Open folder" after downloading it.
import type { ProjectFiles } from "./project";
import { TEMPLATES } from "./templates";

export const SAMPLE_NAME = "tasks";

export function sampleFiles(): ProjectFiles {
  return TEMPLATES[0].files();
}
