import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

/** The example app's sources (app/), as the builder sees them: a FilesApi under /app. */
export async function appFiles(): Promise<MemFilesApi> {
  const files = new MemFilesApi();
  const dir = join(import.meta.dirname, "../app");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) =>
      n === "node_modules"
        ? []
        : statSync(join(d, n)).isDirectory()
          ? walk(join(d, n))
          : [join(d, n)],
    );
  for (const f of walk(dir)) await files.write(`/app/${relative(dir, f)}`, [readFileSync(f)]);
  return files;
}
