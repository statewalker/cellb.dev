import { existsSync } from "node:fs";

/** Directory of a scenario's project: ours (conformance/projects) or celld's own examples. */
export function projectDir(name: string): string {
  const base = new URL(".", import.meta.url).pathname;
  const own = `${base}projects/${name}`;
  return existsSync(own) ? own : `${base}celld-examples/${name}`;
}
