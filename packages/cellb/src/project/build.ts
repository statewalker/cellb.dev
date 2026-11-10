/**
 * `buildProject` (`cellb build`): the build step whose output folder `loadProject` loads, in a
 * browser or on Node. Imports no SQLite: the command stays quiet and light.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bundleWorkerForBrowser } from "./browser-bundle.js";
import {
  BUILD_FORMAT,
  BUILD_MANIFEST,
  BUILT_ASSETS,
  BUILT_WORKER,
  type BuildManifest,
  builtConfig,
} from "./built-project.js";
import { readAssetDirectory, readWranglerConfig } from "./node-project.js";
import { hasNodeCompat } from "./wrangler.js";

export interface BuildProjectOptions {
  /**
   * Lower `await` to generators (default: with nodejs_compat), as `bundleWorkerForBrowser`;
   * `false` for browsers with TC39 AsyncContext only.
   */
  lowerAwait?: boolean;
}

/**
 * `cellb build`: writes the project in `dir` as a folder any static host serves and
 * `loadProject` (browser or Node) loads: `wrangler.json`, `worker.js` (`main` bundled for a
 * browser realm, with nodejs_compat when the flags ask for it), `assets/` and `cellb.json`.
 */
export async function buildProject(
  dir: string,
  outDir: string,
  opts: BuildProjectOptions = {},
): Promise<BuildManifest> {
  dir = resolve(dir);
  outDir = resolve(outDir);
  const config = readWranglerConfig(dir);
  if (!config.main && !config.assets)
    throw new Error("wrangler config has neither `main` nor `assets`");
  const nodeCompat = hasNodeCompat(config);
  const code = config.main
    ? await bundleWorkerForBrowser(resolve(dir, config.main), {
        nodeCompat,
        lowerAwait: opts.lowerAwait,
        rules: config.rules,
      })
    : null;
  const assets = config.assets?.directory
    ? readAssetDirectory(resolve(dir, config.assets.directory))
    : new Map<string, Uint8Array>();
  // A fresh folder: files of an earlier build must not linger as assets.
  for (const name of [BUILD_MANIFEST, "wrangler.json", BUILT_WORKER, BUILT_ASSETS])
    rmSync(join(outDir, name), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "wrangler.json"), `${JSON.stringify(builtConfig(config), null, 2)}\n`);
  if (code !== null) writeFileSync(join(outDir, BUILT_WORKER), code);
  for (const [path, bytes] of assets) {
    const out = join(outDir, BUILT_ASSETS, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
  }
  const manifest: BuildManifest = {
    format: BUILD_FORMAT,
    main: code !== null ? BUILT_WORKER : null,
    assets: [...assets.keys()].sort(),
  };
  // Written last: a folder with a manifest is a complete build.
  writeFileSync(join(outDir, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
