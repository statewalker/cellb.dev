// Builds the platform Worker for every host, from one entry (default src/entries/platform.ts):
//
//   dist/<name>/workerd/   worker.js + the .wasm files it imports as modules, and wrangler.json
//                          (no_bundle). Wrangler, Cloudflare and celld run this folder.
//   dist/<name>/cellb/     worker.js with the WebAssembly compiled from embedded bytes (cellb's
//                          project bundler has no .wasm loader), and wrangler.json. cellb loads
//                          it in Node and in browsers.
//
// workerd and celld forbid compiling WebAssembly from bytes, so `cjs-module-lexer` (whose ESM
// build compiles inline WebAssembly) is aliased to its pure-JS build.
//
//   node scripts/build.mjs [entry] [wrangler config] [name]
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import * as esbuild from "esbuild";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "package.json"));
const entry = resolve(root, process.argv[2] ?? "src/entries/platform.ts");
const configPath = resolve(root, process.argv[3] ?? "wrangler.jsonc");
const name = process.argv[4] ?? "platform";

function parseJsonc(s) {
  return JSON.parse(
    s
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
}
const config = parseJsonc(readFileSync(configPath, "utf8"));
delete config.$schema;
delete config.alias;

/** `.wasm` imports: kept as module imports next to worker.js, or compiled from embedded bytes. */
function wasmPlugin(mode, outdir) {
  return {
    name: "wasm",
    setup(b) {
      b.onResolve({ filter: /\.wasm$/ }, async (args) => {
        if (args.pluginData?.inner) return undefined;
        const r = await b.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { inner: true },
        });
        if (mode === "module") {
          const file = basename(r.path);
          copyFileSync(r.path, join(outdir, file));
          return { path: `./${file}`, external: true };
        }
        return { path: r.path, namespace: "wasm-compile" };
      });
      b.onLoad({ filter: /.*/, namespace: "wasm-compile" }, (args) => ({
        contents: `import bytes from ${JSON.stringify(`${args.path}?binary`)};\nexport default WebAssembly.compile(bytes);\n`,
        resolveDir: dirname(args.path),
      }));
      b.onResolve({ filter: /\?binary$/ }, (args) => ({
        path: args.path.slice(0, -"?binary".length),
        namespace: "wasm-binary",
      }));
      b.onLoad({ filter: /.*/, namespace: "wasm-binary" }, (args) => ({
        contents: readFileSync(args.path),
        loader: "binary",
      }));
    },
  };
}

// The Astro builder Worker (@statewalker/cellb-astro-builder/loaded-builder), loaded through a Worker Loader binding
// where the realm cannot evaluate code: one ES module whose ./config.js and .wasm imports are
// the loaded Worker's other modules. The platform embeds its source (virtual:astro-builder-source).
const builder = await esbuild.build({
  entryPoints: [
    join(
      dirname(require.resolve("@statewalker/cellb-astro-builder/package.json")),
      "src/loaded-builder.ts",
    ),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: [
    "cloudflare:*",
    "node:*",
    "fs",
    "path",
    "url",
    "module",
    "./config.js",
    "./esbuild.wasm",
    "./astro.wasm",
  ],
  alias: { "cjs-module-lexer": join(dirname(require.resolve("cjs-module-lexer")), "lexer.js") },
  keepNames: true,
  logLevel: "warning",
});
const builderSource = builder.outputFiles[0].text;
console.log(`astro builder worker  ${(builderSource.length / 1e6).toFixed(1)} MB (embedded)`);
const builderSourcePlugin = {
  name: "astro-builder-source",
  setup(b) {
    b.onResolve({ filter: /^virtual:astro-builder-source$/ }, (args) => ({
      path: args.path,
      namespace: "astro-builder-source",
    }));
    b.onLoad({ filter: /.*/, namespace: "astro-builder-source" }, () => ({
      contents: `export default ${JSON.stringify(builderSource)};`,
      loader: "js",
    }));
  },
};

for (const mode of ["workerd", "cellb"]) {
  const outdir = join(root, "dist", name, mode);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    outfile: join(outdir, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*", "fs", "path", "url", "module"],
    alias: { "cjs-module-lexer": join(dirname(require.resolve("cjs-module-lexer")), "lexer.js") },
    plugins: [builderSourcePlugin, wasmPlugin(mode === "workerd" ? "module" : "bytes", outdir)],
    keepNames: true,
    logLevel: "warning",
    metafile: true,
  });
  const out = {
    ...config,
    main: "worker.js",
    ...(mode === "workerd" ? { no_bundle: true } : {}),
  };
  writeFileSync(join(outdir, "wrangler.json"), `${JSON.stringify(out, null, 2)}\n`);
  const bytes = readFileSync(join(outdir, "worker.js")).length;
  console.log(`dist/${name}/${mode}/worker.js  ${(bytes / 1e6).toFixed(1)} MB`);
}
