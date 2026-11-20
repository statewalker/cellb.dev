// Layered files in a page: a Lifo build container with egress (through the page's network)
// installs into a FilesApi owned by this thread; containers without network run on it read-only.
import { readText, writeText } from "@statewalker/webrun-files";
import { CompositeFilesApi, cow, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  frameworkBuild,
  frameworkBuildSteps,
  frameworkLayerFiles,
  helloSite,
} from "../../examples/observable-framework/recipe.ts";
import { createIsolatedPool } from "../../src/isolated-pool.ts";

const env = { HOME: "/home/user", OBSERVABLE_TELEMETRY_DISABLE: "true" };
const buildPool = () =>
  createIsolatedPool({
    spawn: () =>
      new Worker(new URL("./isolated-lifo-egress-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [], env, enableInternet: true },
    size: 1,
  });
const runPool = () =>
  createIsolatedPool({
    spawn: () =>
      new Worker(new URL("./isolated-lifo-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [], env },
    size: 1,
  });
const node = (code: string) => ["node", "-e", code];
const filesOf = async (files: Record<string, string>) => {
  const fs = new MemFilesApi();
  for (const [path, content] of Object.entries(files)) await writeText(fs, `/${path}`, content);
  return fs;
};

Object.assign(window, {
  async __layers() {
    const deps = await filesOf({
      "package.json": JSON.stringify({ name: "app", dependencies: { ms: "2.1.3" } }),
    });
    const build = buildPool();
    const t0 = performance.now();
    const install = await build.run({ argv: ["npm", "install"], files: deps, cwd: "/data" });
    const installMs = Math.round(performance.now() - t0);
    await build.close();
    const installed = JSON.parse(await readText(deps, "/node_modules/ms/package.json")).version;

    const runs = runPool();
    const layered = () =>
      new CompositeFilesApi(new MemFilesApi()).mount(
        "/node_modules",
        readOnly(deps),
        "/node_modules",
      );
    const a = layered();
    const first = await runs.run({
      argv: node(`
        const fs = require("fs");
        const ms = require("/data/node_modules/ms");
        fs.writeFileSync("/data/out.txt", ms(90000));
        let refused = "no";
        try { fs.writeFileSync("/data/node_modules/ms/index.js", "tampered"); } catch (e) { refused = e.code; }
        console.log(JSON.stringify({ result: ms(90000), refused }));
      `),
      files: a,
    });
    const out = await readText(a, "/out.txt");
    const second = await runs.run({
      argv: node(
        `const fs = require("fs"); console.log(JSON.stringify([fs.existsSync("/data/out.txt"), require("/data/node_modules/ms")(1000)]))`,
      ),
      files: layered(),
    });
    const top = new MemFilesApi();
    const patched = await runs.run({
      argv: node(`
        const fs = require("fs");
        fs.writeFileSync("/data/node_modules/ms/index.js", "module.exports = () => 'patched'");
        console.log(require("/data/node_modules/ms")(1000));
      `),
      files: cow(readOnly(deps), top),
    });
    const net = await runs.run({
      argv: node(
        "fetch('https://registry.npmjs.org/ms').then((r) => console.log('reached', r.status), (e) => console.log('blocked', e.message))",
      ),
    });
    await runs.close();
    return {
      install: { exitCode: install.exitCode, stdout: install.stdout, stderr: install.stderr },
      installMs,
      installed,
      first: first.stdout,
      firstErr: first.stderr,
      out,
      second: second.stdout,
      patched: patched.stdout,
      topPatched: await readText(top, "/node_modules/ms/index.js"),
      base: await readText(deps, "/node_modules/ms/index.js"),
      net: net.stdout,
    };
  },

  async __framework() {
    const layer = await filesOf(frameworkLayerFiles("/data"));
    const build = buildPool();
    const steps: { argv: string; exitCode: number; ms: number; stderr: string }[] = [];
    for (const argv of frameworkBuildSteps("/data")) {
      const r = await build.run({ argv, files: layer, cwd: "/data", timeoutMs: 600_000 });
      steps.push({
        argv: argv.join(" "),
        exitCode: r.exitCode,
        ms: r.ms,
        stderr: r.stderr.slice(-1500),
      });
      if (r.exitCode !== 0) break;
    }
    await build.close();
    const runs = runPool();
    const sites = [];
    for (const files of [helloSite, { "src/about.md": "# About\n" }]) {
      const top = await filesOf(files);
      const r = await runs.run({
        argv: frameworkBuild("/data"),
        files: cow(readOnly(layer), top),
        cwd: "/data",
        timeoutMs: 300_000,
      });
      const page = Object.keys(files)[0]
        .replace(/^src\//, "")
        .replace(/\.md$/, ".html");
      sites.push({
        exitCode: r.exitCode,
        ms: r.ms,
        stdout: r.stdout.slice(-600),
        stderr: r.stderr.slice(-1500),
        html: (await top.exists(`/dist/${page}`)) ? await readText(top, `/dist/${page}`) : null,
        dist: await Array.fromAsync(top.list("/dist"), (e) => e.name).catch(() => []),
      });
    }
    await runs.close();
    return { steps, sites, layerDist: await layer.exists("/dist") };
  },
});
