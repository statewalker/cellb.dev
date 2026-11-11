// Project templates: folders in this package (sample/tasks, templates/*), as files. Each one is a
// complete project with an AGENTS.md, so an agent starting from it knows its layout and API.
import { encode, type ProjectFiles } from "./project";

const sample = import.meta.glob("../../sample/tasks/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const others = import.meta.glob("../../templates/*/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Template {
  id: string;
  title: string;
  description: string;
  files(): ProjectFiles;
}

function filesUnder(raw: Record<string, string>, prefix: string): ProjectFiles {
  const files: ProjectFiles = new Map();
  for (const [path, text] of Object.entries(raw))
    if (path.startsWith(`${prefix}/`)) files.set(path.slice(prefix.length), encode(text));
  return files;
}

export const TEMPLATES: Template[] = [
  {
    id: "tasks",
    title: "Tasks: Hono + Durable Object + React",
    description:
      "A to-do list: a Hono API, one SQLite-backed Durable Object per list, a React TSX client.",
    files: () => filesUnder(sample, "../../sample/tasks"),
  },
  {
    id: "agent-ui",
    title: "Agent UI: a screen an agent pilots",
    description:
      "The screen is a JSON spec in a Durable Object (json-render / A2UI style), rendered from a fixed catalog; agents change it over HTTP, clicks come back as actions.",
    files: () => filesUnder(others, "../../templates/agent-ui"),
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);
