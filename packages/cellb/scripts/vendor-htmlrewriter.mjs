// Vendors the `htmlrewriter` package's WASM build (lol-html) with two fixes. First, its
// html_rewriter.js never hands the WASM exports to asyncify.js, so ASYNC handlers fail
// ("Cannot read properties of undefined (reading 'asyncify_get_state')"). The patch calls
// setWasmExports() right after instantiation.   node scripts/vendor-htmlrewriter.mjs
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const pkg = realpathSync(join(app, "node_modules/htmlrewriter"));
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
const out = join(app, "vendor/htmlrewriter");
mkdirSync(out, { recursive: true });
for (const f of ["asyncify.js", "html_rewriter_wrapper.js", "html_rewriter_bg.wasm"])
  copyFileSync(join(pkg, "dist", f), join(out, f));
let src = readFileSync(join(pkg, "dist/html_rewriter.js"), "utf8");
const before = src;
src = src.replace(
  "import { awaitPromise } from './asyncify.js';",
  "import { awaitPromise, setWasmExports } from './asyncify.js';",
);
src = src.replace(
  "    wasm = instance.exports;\n",
  "    wasm = instance.exports;\n    setWasmExports(wasm); // webrun-cells patch: asyncify needs the exports\n",
);
if (src === before || !src.includes("setWasmExports(wasm)"))
  throw new Error("htmlrewriter: patch did not apply");
writeFileSync(
  join(out, "html_rewriter.js"),
  `// htmlrewriter@${version} (MIT), patched by scripts/vendor-htmlrewriter.mjs\n${src}`,
);
// Second fix: with asyncify, write()/end() return promises when a handler is async — the
// wrapper must await them (it did not, which panics lol-html with "unreachable").
const wrapper = readFileSync(join(out, "html_rewriter_wrapper.js"), "utf8")
  .replace("'../dist/html_rewriter.js'", "'./html_rewriter.js'")
  .replace(
    "                        rewriter.write(value);",
    "                        await rewriter.write(value);",
  )
  .replace("                    rewriter.end();", "                    await rewriter.end();")
  .replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n"); // the map would not match the patched file
if (!wrapper.includes("await rewriter.write(value)") || !wrapper.includes("await rewriter.end()"))
  throw new Error("htmlrewriter: wrapper patch did not apply");
// The source maps are not vendored: drop their references (loaders fail on missing maps).
const noMap = (t) => t.replace(/^\/\/# sourceMappingURL=.*$/gm, "");
writeFileSync(join(out, "html_rewriter_wrapper.js"), noMap(wrapper));
for (const f of ["asyncify.js", "html_rewriter.js"])
  writeFileSync(join(out, f), noMap(readFileSync(join(out, f), "utf8")));
console.log(`vendor/htmlrewriter ← htmlrewriter@${version} (+ two asyncify fixes)`);
