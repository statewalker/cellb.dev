// Bundles the Node spread probe (node.ts, node-shard.ts) with esbuild and runs it:
//   node probes/spread/run-node.mjs [tasks|threads|volume|backup ...]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = import.meta.dirname;
const out = mkdtempSync(join(tmpdir(), "spread-probe-"));
const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
  // The project imports DurableObject from cloudflare:workers: cellb's own class.
  alias: { "cloudflare:workers": resolve(here, "../../src/core/durable-object.ts") },
  external: ["esbuild"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};
await build({
  ...common,
  entryPoints: { shard: join(here, "node-shard.ts"), main: join(here, "node.ts") },
  outdir: out,
});
process.env.SPREAD_SHARD_SCRIPT = join(out, "shard.js");
process.env.SPREAD_PROJECT_DIR = join(here, "project");
await import(pathToFileURL(join(out, "main.js")).href);
