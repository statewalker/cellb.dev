// Builds the published package: dist/ mirrors src/ (ES modules, declarations, source maps).
//   1. tsc -p tsconfig.build.json
//   2. the hand-written declarations (src/**/*.d.ts), which tsc does not copy
//   3. worker URLs written for the sources (`new URL("…/x.ts", import.meta.url)`) point at the
//      compiled `.js`: bundlers (Vite) find a worker by that literal, so it stays a literal.
// vendor/ is published beside dist/ and reached the same way from both (`../../vendor/…`).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");
const dist = join(root, "dist");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

for (const f of walk(src).filter((f) => f.endsWith(".d.ts")))
  cpSync(f, join(dist, relative(src, f)));

const URL_TS = /new URL\(\s*"([^"]+)\.ts"\s*,\s*import\.meta\.url\s*\)/g;
let rewritten = 0;
for (const f of walk(dist).filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(f, "utf8");
  const out = text.replace(URL_TS, (m, path) => {
    const js = resolve(dirname(f), `${path}.js`);
    if (!existsSync(js)) throw new Error(`${relative(root, f)}: ${path}.js does not exist`);
    rewritten++;
    return `new URL("${path}.js", import.meta.url)`;
  });
  if (out !== text) writeFileSync(f, out);
}
const left = walk(dist).filter(
  (f) => f.endsWith(".js") && /new URL\(\s*"[^"]+\.ts"/.test(readFileSync(f, "utf8")),
);
if (left.length) throw new Error(`.ts URLs left in ${left.join(", ")}`);
// Any other relative `.ts` path written as a string (e.g. in code generated for esbuild) names a
// file that exists only in the sources: resolve such paths with ownModule() instead.
const TS_PATH = /["'`]\.{1,2}\/[^"'`\n]*\.ts["'`]/;
const tsPaths = walk(dist).filter(
  (f) => f.endsWith(".js") && TS_PATH.test(readFileSync(f, "utf8")),
);
if (tsPaths.length)
  throw new Error(`source-only .ts paths in ${tsPaths.map((f) => relative(root, f)).join(", ")}`);
console.log(
  `dist/: ${walk(dist).filter((f) => f.endsWith(".js")).length} modules, ${rewritten} worker URL(s) rewritten`,
);
