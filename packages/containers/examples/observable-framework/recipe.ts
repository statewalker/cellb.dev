// Observable Framework (https://observablehq.com/framework/) in Lifo containers, as two layers:
// a build step with egress installs Framework into a FilesApi and adapts its CLI to Lifo; runs
// without network build sites on that layer, read-only. The same code in browsers and Node.
//
// Framework's CLI does not run in Lifo as published. The adaptation, done once in the build step:
// - its CLI is bundled with esbuild (Lifo's ESM loader mis-parses some dependencies, e.g. a
//   comment inside an export list); jsdom, esbuild and rollup stay outside the bundle (jsdom finds
//   files next to itself; rollup is @rollup/wasm-node, as Lifo cannot load native addons);
//   so is debug's optional supports-color, which esbuild-wasm (Lifo's esbuild in browsers) cannot
//   look up on a filesystem it does not have;
// - Lifo lacks node:path/posix (its path is POSIX), node:timers/promises and util.parseArgs /
//   util.deprecate: shims below;
// - Lifo's esbuild resolves through its own VFS plugin, which ignores `external` and resolves a
//   cwd-relative alias as a package: a wrapper turns Framework's style aliases into a plugin;
// - Framework fetches its client's npm modules during a build, resolving versions from its cache
//   (src/.observablehq/cache) first: the build step builds a page once to fill it;
// - Lifo's import() keeps a query string in the path: no observablehq.config.js (Framework imports
//   it with a cache-busting query); the defaults apply (root: "src").

export const FRAMEWORK_VERSION = "1.13.4";

/** The base layer's starting files: package.json and the adaptation (all under `dir` in the guest). */
export function frameworkLayerFiles(dir: string): Record<string, string> {
  const pkg = {
    name: "observable-framework-layer",
    private: true,
    type: "module",
    dependencies: {
      "@observablehq/framework": FRAMEWORK_VERSION,
      "@rollup/wasm-node": "4.68.7",
      "@pkgjs/parseargs": "0.11.0",
    },
  };
  const util = [
    "const { createRequire } = require('node:module');",
    `const u = createRequire(${JSON.stringify(`${dir}/x.js`)})('util');`,
    "const out = Object.create(u);",
    "out.parseArgs = u.parseArgs ?? require('@pkgjs/parseargs').parseArgs;",
    "out.deprecate = u.deprecate ?? ((fn) => fn);",
    "out.inspect = u.inspect;",
    "out.promisify = u.promisify;",
    "module.exports = out;",
  ].join("\n");
  const esbuild = [
    "const { createRequire } = require('node:module');",
    `const real = createRequire(${JSON.stringify(`${dir}/x.js`)})('esbuild');`,
    "const abs = (p) => (p.startsWith('/') || p.startsWith('.') ? p : process.cwd() + '/' + p);",
    "const fix = (o = {}) => ({",
    "  ...o,",
    "  alias: undefined,",
    "  plugins: [...(o.plugins ?? []), ...(o.alias ? [{ name: 'lifo-alias', setup(b) {",
    "    b.onResolve({ filter: /.*/ }, (a) => (a.path in o.alias ? { path: abs(o.alias[a.path]), namespace: 'file' } : null));",
    "  } }] : [])],",
    "  ...(o.stdin && { stdin: { resolveDir: process.cwd(), ...o.stdin } }),",
    "});",
    "const out = Object.create(real);",
    "out.build = (o) => real.build(fix(o));",
    "out.context = (o) => real.context(fix(o));",
    "module.exports = out;",
  ].join("\n");
  const prepare = `
import esbuild from "esbuild";
import fs from "node:fs";
const dir = ${JSON.stringify(dir)};
const fw = dir + "/node_modules/@observablehq/framework";
const timers = "export const setTimeout = (ms, v) => new Promise((r) => globalThis.setTimeout(() => r(v), ms)); export const setImmediate = (v) => new Promise((r) => globalThis.setTimeout(() => r(v), 0)); export const scheduler = { wait: (ms) => new Promise((r) => globalThis.setTimeout(r, ms)), yield: () => Promise.resolve() }; export default { setTimeout, setImmediate, scheduler };";
const r = await esbuild.build({
  entryPoints: [fw + "/dist/bin/observable.js"],
  outfile: fw + "/dist/observable.lifo.mjs",
  bundle: true, platform: "node", format: "esm", target: "es2022", logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: "lifo", setup(b) {
    b.onResolve({ filter: /^ws$/ }, () => ({ path: dir + "/node_modules/ws/index.js" }));
    b.onResolve({ filter: /^(jsdom|rollup|@rollup\\/wasm-node|fsevents|tsx|supports-color|bufferutil|utf-8-validate)(\\/.*)?$/ }, (a) => ({ path: a.path.replace(/^rollup/, "@rollup/wasm-node"), external: true }));
    b.onResolve({ filter: /^esbuild$/ }, (a) => (a.importer.endsWith("/lifo-esbuild.cjs") ? null : { path: dir + "/lifo-esbuild.cjs" }));
    b.onResolve({ filter: /^(node:)?util$/ }, () => ({ path: dir + "/lifo-util.cjs" }));
    b.onResolve({ filter: /^(node:)?path\\/posix$/ }, () => ({ path: "node:path", external: true }));
    b.onResolve({ filter: /^(node:)?timers\\/promises$/ }, () => ({ path: "timers/promises", namespace: "lifo-shim" }));
    b.onLoad({ filter: /.*/, namespace: "lifo-shim" }, () => ({ contents: timers, loader: "js" }));
  } }],
});
// css-tree reads ../data/patch.json relative to its own file, now the bundle's
fs.mkdirSync(fw + "/data", { recursive: true });
for (const f of fs.readdirSync(dir + "/node_modules/css-tree/data"))
  fs.writeFileSync(fw + "/data/" + f, fs.readFileSync(dir + "/node_modules/css-tree/data/" + f));
console.log("prepared", r.errors.length ? "with errors" : "ok");
`;
  return {
    "package.json": JSON.stringify(pkg, null, 2),
    "lifo-util.cjs": util,
    "lifo-esbuild.cjs": esbuild,
    "prepare.mjs": prepare,
    // a page built once in the build step: Framework downloads its client's npm modules
    // into src/.observablehq/cache, where builds without network find them
    "src/index.md": "# Warm-up\n",
  };
}

/** Commands of the build step, run in the layer's directory `dir` (with egress). */
export function frameworkBuildSteps(dir: string): string[][] {
  return [
    ["npm", "install"],
    ["node", "prepare.mjs"],
    // fill Framework's npm cache, then drop the warm-up page and its output
    frameworkBuild(dir),
    [
      "node",
      "-e",
      "const fs = require('fs'); fs.rmSync('src/index.md'); fs.rmSync('dist', { recursive: true, force: true })",
    ],
  ];
}

/** The command that builds the site whose sources are in `<cwd>/src`, into `<cwd>/dist`. */
export function frameworkBuild(layerDir: string): string[] {
  return [
    "node",
    `${layerDir}/node_modules/@observablehq/framework/dist/observable.lifo.mjs`,
    "build",
  ];
}

/** The command that serves the site in `<cwd>/src` with live reload (until it is stopped). */
export function frameworkPreview(layerDir: string, port = 3000): string[] {
  return [
    "node",
    `${layerDir}/node_modules/@observablehq/framework/dist/observable.lifo.mjs`,
    "preview",
    "--no-open",
    "--port",
    String(port),
  ];
}

/** A one-page site. */
export const helloSite: Record<string, string> = {
  "src/index.md": "# Hello from a container\n\nOne plus one is ${1 + 1}.\n",
};
