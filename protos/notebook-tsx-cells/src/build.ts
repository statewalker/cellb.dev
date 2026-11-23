// PROTOTYPE (statewalker/statewalker-root#236). Builds one notebook page.
import { readFile } from "node:fs/promises";
import { emitPage } from "./emit.ts";
import { exportModules } from "./export.ts";
import { createModuleServer } from "./modules.ts";
import { parsePage } from "./parse.ts";
import { reactiveChecker, type TypeChecker } from "./checkers.ts";
import type { BuildError } from "./typecheck.ts";

export type BuildResult = { ok: boolean; errors: BuildError[] };

export async function buildPage(pagePath: string, outDir: string, options: { checker?: TypeChecker; modules?: ReturnType<typeof createModuleServer>; exportModules?: boolean } = {}): Promise<BuildResult> {
  const markdown = await readFile(pagePath, "utf8");
  const title = /^title:\s*(.+)$/m.exec(markdown)?.[1] ?? "Notebook";
  const blocks = parsePage(markdown.replace(/^---\n[\s\S]*?\n---\n/, (m) => "\n".repeat(m.split("\n").length - 1)));
  const cells = blocks.flatMap((b) => (b.kind === "cell" ? [b.cell] : []));
  const errors = (options.checker ?? reactiveChecker).check({ path: pagePath, cells });
  if (errors.length) return { ok: false, errors };
  const modules = options.modules ?? createModuleServer();
  const { runtimeUrl, stylesUrl, used } = await emitPage(pagePath, blocks, outDir, title, modules);
  if (options.exportModules) await exportModules(modules, outDir, [runtimeUrl, stylesUrl], runtimeUrl, used);
  return { ok: true, errors };
}
