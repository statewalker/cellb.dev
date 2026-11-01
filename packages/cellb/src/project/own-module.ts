import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A module file of cellb itself, by path, for a bundler or `import()` at run time (Node only):
 * the compiled `.js` beside the caller in the published package (`dist/`), the TypeScript source
 * in the repository (`src/`). `rel` is relative to `dir`, with or without its `.ts` extension.
 */
export function ownModule(dir: string, rel: string): string {
  const base = rel.replace(/\.ts$/, "");
  const js = resolve(dir, `${base}.js`);
  return existsSync(js) ? js : resolve(dir, `${base}.ts`);
}
