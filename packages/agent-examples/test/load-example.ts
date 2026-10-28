import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const examples = resolve(import.meta.dirname, "..");

/**
 * Loads an example on cellb (Node) with some of its vars replaced (the model endpoint): a
 * temporary `wrangler.json` whose `main` is the example's own file, so that its packages resolve
 * from this package's node_modules.
 */
export async function loadExample(name: string, vars: Record<string, string>) {
  const text = readFileSync(join(examples, name, "wrangler.jsonc"), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  config.main = join(examples, name, config.main);
  config.vars = { ...config.vars, ...vars };
  const dir = mkdtempSync(join(tmpdir(), `agent-${name}-`));
  writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config));
  return loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
}
