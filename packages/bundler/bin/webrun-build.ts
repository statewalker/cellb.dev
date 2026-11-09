/**
 * The bundler's Node tier: builds too large for a Workers isolate (EmDash's server bundle peaks
 * far above 128 MB) run here, with the same `buildProject` the bundler's Durable Object runs.
 *
 *   tsx bin/webrun-build.ts <project dir> --out <dir> [--platform <origin>] [--entry <path>]
 *                           [--minify] [--no-sourcemap] [--wasm] [--spec <BuildSpec JSON>]
 *       an Astro project (astro.config.*) is built from its sources first (src/astro).
 *       builds a local project; packages come from the project's node_modules, then from the
 *       platform's package store (`--platform`), else from the npm registry.
 *
 *   tsx bin/webrun-build.ts --runner <origin> [--once] [--wasm]
 *       claims queued builds from a platform (`POST /builds?tier=runner`), builds them and
 *       uploads the output.
 *
 * Native esbuild by default; `--wasm` uses esbuild-wasm, as the Durable Object does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isAstroProject } from "@statewalker/cellb-astro-builder/project";
import { readTree } from "@statewalker/cellb-platform-core/tree";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { buildAny } from "../src/any.js";
import { type BuildSpec, defaultPackages } from "../src/build.js";

/** Astro's compiler on Node: the native build of @astrojs/compiler-rs. */
const astroCompiler = async () => (await import("@astrojs/compiler-rs")).transform as never;

import { remoteRegistryFetch } from "@statewalker/cellb-platform-core/registry-fetch";
import { unzip, zip } from "@statewalker/cellb-platform-core/util";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function loadEsbuild() {
  if (flag("wasm")) {
    const esbuild = await import("esbuild-wasm");
    await esbuild.initialize({});
    return esbuild;
  }
  return import("esbuild");
}

async function runLocal(dir: string) {
  const out = resolve(opt("out") ?? join(dir, "dist-webrun"));
  const platform = opt("platform");
  const spec: BuildSpec = {
    ...(opt("spec") ? (JSON.parse(opt("spec") as string) as BuildSpec) : {}),
    entry: opt("entry"),
    minify: flag("minify"),
    sourcemap: !flag("no-sourcemap"),
    lowerAwait: flag("lower-await"),
  };
  let files: import("@statewalker/webrun-files").FilesApi = new NodeFilesApi({
    rootDir: resolve(dir),
  });
  // An Astro project is built from its sources alone: not its node_modules, nor earlier output.
  if (await isAstroProject(files)) {
    const sources = new MemFilesApi();
    for (const [p, b] of readTree(resolve(dir), resolve(dir), ["dist"]))
      await sources.write(p, [b]);
    files = sources;
  }
  const result = await buildAny({
    astroCompiler,
    files,
    esbuild: await loadEsbuild(),
    packages: defaultPackages(platform ? remoteRegistryFetch(platform) : undefined),
    spec,
    log: (m) => console.error(`[webrun-build] ${m}`),
  });
  for (const [p, bytes] of result.files) {
    const f = join(out, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  }
  console.error(`[webrun-build] wrote ${result.files.size} files to ${out}`);
  console.log(JSON.stringify(result.stats));
}

async function runRunner(origin: string) {
  const esbuild = await loadEsbuild();
  for (;;) {
    const claim = await fetch(`${origin}/builds/claim`, { method: "POST" });
    if (claim.status === 204) {
      if (flag("once")) return;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const job = (await claim.json()) as { id: string; input: string; output: string };
    console.error(`[runner] claimed ${job.id}`);
    try {
      const res = await fetch(job.input);
      const spec = JSON.parse(res.headers.get("x-build-spec") ?? "{}") as BuildSpec;
      const files = new MemFilesApi();
      for (const [p, b] of await unzip(new Uint8Array(await res.arrayBuffer())))
        await files.write(p, [b]);
      const result = await buildAny({
        astroCompiler,
        files,
        esbuild,
        packages: defaultPackages(remoteRegistryFetch(origin)),
        spec,
        log: (m) => console.error(`[runner] ${job.id}: ${m}`),
      });
      const up = await fetch(job.output, {
        method: "PUT",
        headers: {
          "x-build-stats": JSON.stringify({
            ...result.stats,
            ...(result.astro ? { astro: result.astro } : {}),
            tier: "runner",
          }),
        },
        body: zip([...result.files]) as BodyInit,
      });
      console.error(`[runner] ${job.id}: uploaded (${up.status})`);
    } catch (e) {
      console.error(`[runner] ${job.id}: failed`, e);
      await fetch(`${origin}/builds/${job.id}/fail`, {
        method: "POST",
        body: String((e as Error).stack ?? e),
      });
    }
    if (flag("once")) return;
  }
}

const runner = opt("runner");
if (runner) await runRunner(runner.replace(/\/+$/, ""));
else if (args[0] && !args[0].startsWith("--")) await runLocal(args[0]);
else {
  console.error(
    "usage: webrun-build <dir> --out <dir> [--platform <origin>] | webrun-build --runner <origin> [--once]",
  );
  process.exit(2);
}
