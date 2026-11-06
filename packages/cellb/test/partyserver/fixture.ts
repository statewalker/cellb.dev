import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { WranglerConfig } from "../../src/index.js";
import { readWranglerConfig } from "../../src/project/node-project.js";

export const fixtureDir = import.meta.dirname;

/** The extension's bundle, as a package would ship it: partyserver inside, `cloudflare:workers` not. */
export async function pluginBundle(): Promise<string> {
  const out = await build({
    entryPoints: [join(fixtureDir, "plugin.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

/** The host project's configuration, with the extension's bundle in `PLUGIN_CODE`. */
export async function partyConfig(): Promise<WranglerConfig> {
  const config = readWranglerConfig(fixtureDir);
  return { ...config, vars: { ...config.vars, PLUGIN_CODE: await pluginBundle() } };
}

/** A project directory for loadNodeProject: that configuration, `main` pointing back here. */
export async function partyProjectDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "partyserver-"));
  const config = await partyConfig();
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({ ...config, main: join(fixtureDir, "index.js") }),
  );
  return dir;
}
