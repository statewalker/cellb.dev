import { existsSync } from "node:fs";
import { scenarios } from "./scenarios.js";

/**
 * Directory of a scenario's project: ours (conformance/projects), workerd's own tests
 * (conformance/workerd-tests) or celld's own examples.
 */
export function projectDir(name: string): string {
  name = scenarios[name]?.project ?? name;
  const base = new URL(".", import.meta.url).pathname;
  for (const dir of ["projects", "workerd-tests"])
    if (existsSync(`${base}${dir}/${name}`)) return `${base}${dir}/${name}`;
  return `${base}celld-examples/${name}`;
}
