// Applies dist/client/.assetsignore the way `wrangler deploy` does (the listed files are not
// uploaded, nor is .assetsignore itself), then removes it: cellb, like celld, refuses a project
// whose assets directory still holds an .assetsignore.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const dir = join(import.meta.dirname, "../dist/client");
const ignoreFile = join(dir, ".assetsignore");
if (existsSync(ignoreFile)) {
  const patterns = readFileSync(ignoreFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // Astro writes plain file names; globs are matched with path.matchesGlob.
  const { matchesGlob } = await import("node:path");
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
    );
  for (const file of walk(dir)) {
    const rel = relative(dir, file);
    const base = rel.split("/").at(-1);
    if (patterns.some((p) => p === rel || p === base || matchesGlob(rel, p))) rmSync(file);
  }
  rmSync(ignoreFile, { force: true });
}
