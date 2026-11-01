// Checks the package as it is published: `pnpm pack` (which builds dist/); the packed manifest
// (no workspace:/catalog:/link:/file: specifier, every export target present, every bare import of
// dist/ and vendor/ declared); then the tarball installed with npm in a project of its own,
// outside this workspace, and used three ways:
//   1. plain Node: a wrangler project with a Durable Object and nodejs_compat, through
//      loadNodeProject (esbuild, the module files cellb loads at run time), and
//      bundleWorkerForBrowser; the process must end by itself afterwards
//   2. TypeScript: a consumer file type-checked against the published declarations
//   3. Vite + Chromium: an app bundles @statewalker/cellb/browser (its workers included), and the
//      Worker runs on cellb in a Dedicated Worker, its Durable Object on OPFS
// Needs network access to the npm registry. PW_CHROMIUM: a Chromium binary (else Playwright's).
// KEEP=1 keeps the temporary directory.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "cellb-pack-check-"));
const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const step = (s) => console.log(`\n── ${s}`);
const write = (path, text) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

try {
  step("pack");
  run("pnpm", ["pack", "--pack-destination", work], pkgDir);
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("no tarball");

  step("the packed manifest and files");
  const packed = join(work, "packed");
  mkdirSync(packed);
  run("tar", ["xzf", join(work, tarball), "-C", packed], work);
  const pkgRoot = join(packed, "package");
  const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const problems = [];
  // No specifier a consumer cannot resolve.
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"])
    for (const [name, spec] of Object.entries(manifest[field] ?? {}))
      if (/^(workspace|catalog|link|file):/.test(spec)) problems.push(`${field}.${name}: ${spec}`);
  if (manifest.private) problems.push("the packed manifest is private");
  // Every export target is in the tarball.
  for (const [sub, target] of Object.entries(manifest.exports ?? {}))
    for (const file of typeof target === "string" ? [target] : Object.values(target))
      if (!existsSync(join(pkgRoot, file))) problems.push(`exports["${sub}"]: ${file} is missing`);
  // Every bare import of the shipped code is declared (or a Node built-in, or one of the
  // specifiers cellb's own bundling resolves: cellb:*, cloudflare:*, virtual modules).
  const declared = new Set(
    ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((f) =>
      Object.keys(manifest[f] ?? {}),
    ),
  );
  const builtin = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
  const IMPORT =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const file of [...walk(join(pkgRoot, "dist")), ...walk(join(pkgRoot, "vendor"))]) {
    if (!/\.(m?js|d\.ts)$/.test(file)) continue;
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const [, spec] of code.matchAll(IMPORT)) {
      if (/^(node|cellb|cloudflare|cells|virtual|memory):/.test(spec) || spec.includes("://"))
        continue;
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) continue; // not a package name
      if (builtin.has(name) || declared.has(name)) continue;
      problems.push(`${file.slice(pkgRoot.length + 1)}: imports undeclared "${spec}"`);
    }
  }
  if (problems.length) throw new Error(`packed package:\n  ${problems.join("\n  ")}`);
  console.log(`packed: ${Object.keys(manifest.exports).length} exports, imports all declared`);

  step("install the tarball with npm, outside the workspace");
  const app = join(work, "app");
  write(
    join(app, "package.json"),
    JSON.stringify(
      {
        name: "cellb-pack-check",
        private: true,
        type: "module",
        dependencies: {
          "@statewalker/cellb": `file:../${tarball}`,
          "@statewalker/webrun-files-mem": pkg.dependencies["@statewalker/webrun-files-mem"],
          "@sqlite.org/sqlite-wasm": pkg.dependencies["@sqlite.org/sqlite-wasm"],
          esbuild: pkg.devDependencies.esbuild,
        },
        devDependencies: { vite: "^8.0.0", "@types/node": "^22.0.0" },
      },
      null,
      2,
    ),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], app);

  // A wrangler project: a Durable Object, nodejs_compat (node:buffer), cloudflare:workers.
  const project = join(app, "project");
  const config = {
    name: "pack-check",
    main: "index.js",
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
  };
  write(join(project, "wrangler.json"), JSON.stringify(config, null, 2));
  write(
    join(project, "index.js"),
    `import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
export class Counter extends DurableObject {
  async inc() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
export default {
  async fetch(req, env) {
    const n = await env.COUNTER.getByName("a").inc();
    return new Response(Buffer.from("n=" + n).toString());
  },
};
`,
  );

  step("1. plain Node: loadNodeProject, bundleWorkerForBrowser");
  write(
    join(app, "node-check.mjs"),
    `import * as iso from "@statewalker/cellb";
import { bundleWorkerForBrowser, loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { writeFileSync } from "node:fs";
if (typeof iso.createCellRuntime !== "function") throw new Error("no createCellRuntime");
const { runtime, unsupported } = await loadNodeProject(${JSON.stringify(project)}, {
  openSql: nodeSqliteOpener(),
  files: new MemFilesApi(),
});
if (unsupported.length) throw new Error("unsupported: " + unsupported.join("; "));
const got = [];
for (let i = 0; i < 2; i++) got.push(await (await runtime.fetch(new Request("http://x/"))).text());
await runtime.close();
if (got.join(",") !== "n=1,n=2") throw new Error("got " + got.join(","));
const bundle = await bundleWorkerForBrowser(${JSON.stringify(join(project, "index.js"))}, { nodeCompat: true });
if (!bundle.includes("Counter")) throw new Error("the browser bundle has no Counter");
writeFileSync("worker-bundle.js", bundle);
console.log("node: " + got.join(", ") + "; browser bundle " + bundle.length + " bytes");
`,
  );
  // The process must end by itself once the runtime is closed (no handle left open).
  execFileSync(process.execPath, ["node-check.mjs"], {
    cwd: app,
    stdio: "inherit",
    timeout: 120_000,
  });

  step("2. TypeScript: the published declarations");
  write(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["node"],
        skipLibCheck: false, // the published declarations are checked too
      },
      files: ["types-check.ts"],
    }),
  );
  write(
    join(app, "types-check.ts"),
    `import { createWebSocketClass, type CellStorage, type ObjectStore } from "@statewalker/cellb";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { browserProjectRuntime, joinProjectShards } from "@statewalker/cellb/browser";
import { cellbHostModule, CELLS_GLOBALS_MODULE } from "@statewalker/cellb/host-modules";
const open: ReturnType<typeof nodeSqliteOpener> = nodeSqliteOpener();
const load: typeof loadNodeProject = loadNodeProject;
const WS: typeof WebSocket = createWebSocketClass(async () => { throw new Error("x"); });
const src: string | undefined = cellbHostModule("cloudflare:workers");
type Uses = [CellStorage, ObjectStore, typeof browserProjectRuntime, typeof joinProjectShards];
export { open, load, WS, src, CELLS_GLOBALS_MODULE, type Uses };
`,
  );
  run(join(pkgDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], app);
  console.log("types: ok");

  step("3. Vite + Chromium: @statewalker/cellb/browser in a Dedicated Worker");
  write(
    join(app, "web/index.html"),
    `<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>`,
  );
  write(
    join(app, "web/main.js"),
    `const w = new Worker(new URL("./cell-worker.js", import.meta.url), { type: "module" });
w.onmessage = (e) => (document.body.dataset.result = JSON.stringify(e.data));
w.onerror = (e) => (document.body.dataset.result = JSON.stringify({ error: e.message }));
`,
  );
  write(
    join(app, "web/cell-worker.js"),
    `import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { browserProjectRuntime } from "@statewalker/cellb/browser";
import bundle from "../worker-bundle.js?raw";
try {
  const host = await browserProjectRuntime({
    config: ${JSON.stringify(config)},
    code: { bundle },
    sqlite3: await sqlite3InitModule(),
    pool: "pack-check-" + Math.random().toString(36).slice(2),
    filesDir: "pack-check-files",
  });
  const got = [];
  for (let i = 0; i < 2; i++) got.push(await (await host.runtime.fetch(new Request("http://browser/"))).text());
  await host.close();
  postMessage({ got });
} catch (err) {
  postMessage({ error: String(err?.stack ?? err) });
}
`,
  );
  write(
    join(app, "vite.config.mjs"),
    `export default { root: "web", worker: { format: "es" }, build: { outDir: "../web-dist", emptyOutDir: true, target: "es2022" } };`,
  );
  run(join(app, "node_modules/.bin/vite"), ["build", "--logLevel", "warn"], app);
  const assets = readdirSync(join(app, "web-dist/assets"));
  // The LTX store worker (bucket: { ltx }) is referenced by URL: the bundler must emit it.
  if (!assets.some((a) => a.startsWith("ltx-store-worker")))
    throw new Error(`no ltx-store-worker among the built assets: ${assets.join(", ")}`);
  const preview = spawn(
    join(app, "node_modules/.bin/vite"),
    ["preview", "--port", "4799", "--strictPort"],
    { cwd: app, stdio: "ignore" },
  );
  try {
    const { chromium } = await import("@playwright/test");
    const executablePath = process.env.PW_CHROMIUM || undefined;
    const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      for (let i = 0; ; i++) {
        const ok = await page.goto("http://localhost:4799/").then(
          () => true,
          () => false,
        );
        if (ok) break;
        if (i > 50) throw new Error("vite preview did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
      await page.waitForFunction(() => document.body.dataset.result, null, { timeout: 60_000 });
      const result = JSON.parse(await page.evaluate(() => document.body.dataset.result));
      if (result.error) throw new Error(`in the browser: ${result.error}`);
      if (result.got.join(",") !== "n=1,n=2") throw new Error(`browser got ${result.got}`);
      console.log(`browser: ${result.got.join(", ")}`);
    } finally {
      await browser.close();
    }
  } finally {
    preview.kill();
  }

  step("the published package works");
} finally {
  if (process.env.KEEP) console.log(`kept ${work}`);
  else if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
