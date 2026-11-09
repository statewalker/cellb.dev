/**
 * `buildAny`: what the bundler runs for a build, in every tier. An Astro project (an
 * `astro.config.*`, or `kind: "astro"`) is first built from its sources by the ported in-browser
 * Astro builder (src/astro), which emits what Astro's Cloudflare build does; that output, like any
 * other Worker project, then goes through `buildProject` (one module, host compatibility).
 */

import type { AstroTransform } from "@statewalker/cellb-astro-builder/astro-plugin";
import { buildAstroProject, isAstroProject } from "@statewalker/cellb-astro-builder/project";
import { projectPeers } from "@statewalker/cellb-platform-core/peers";
import type { Esbuild, PackageStore } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { type BuildOutput, type BuildSpec, buildProject, defaultPackages } from "./build.js";

export async function buildAny(opts: {
  files: FilesApi;
  esbuild: Esbuild;
  packages?: PackageStore;
  spec?: BuildSpec;
  /** Astro's compiler, loaded only for an Astro build. */
  astroCompiler: () => Promise<AstroTransform>;
  /**
   * Runs the Astro build instead of `buildAstroProject` in this realm (a Worker Loader isolate,
   * where this realm cannot evaluate the project's config: src/astro/loader.ts).
   */
  runAstro?: (
    packages: PackageStore,
  ) => Promise<{ files: Map<string, Uint8Array>; routes: number; ms: number }>;
  log?: (msg: string) => void;
}): Promise<BuildOutput & { astro?: { routes: number; ms: number } }> {
  const spec = opts.spec ?? {};
  const packages = await projectPeers(opts.packages ?? defaultPackages(), opts.files);
  const kind = spec.kind ?? ((await isAstroProject(opts.files)) ? "astro" : "worker");
  if (kind !== "astro") return buildProject({ ...opts, packages, spec: { ...spec, kind } });
  opts.log?.("an Astro project: building it from its sources");
  const astro = opts.runAstro
    ? await opts.runAstro(packages)
    : await buildAstroProject({
        files: opts.files,
        esbuild: opts.esbuild,
        transform: await opts.astroCompiler(),
        packages,
        spec: spec.astro,
        log: opts.log,
      });
  const files = new MemFilesApi();
  for (const [p, b] of astro.files) await files.write(p, [b]);
  const out = await buildProject({
    files,
    esbuild: opts.esbuild,
    packages,
    spec: { ...spec, kind: "worker", entry: undefined },
    log: opts.log,
  });
  return { ...out, astro: { routes: astro.routes, ms: astro.ms } };
}
