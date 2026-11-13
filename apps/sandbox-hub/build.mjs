// One file per command (dist/sandbox-hub.mjs, dist/bridge.mjs): Node and the native WebRTC module
// (node-datachannel, kept external) are all a host needs. Used by the Dockerfile and deploy/.
import { build } from "esbuild";

await build({
  entryPoints: { "sandbox-hub": "src/main.ts", bridge: "src/bridge.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CellB (which runs the hosted apps) is installed next to the bundle, as node-datachannel is.
  external: ["node-datachannel", "@statewalker/cellb", "@statewalker/cellb/*"],
  // Some dependencies call require() on Node built-ins from ESM.
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
  logLevel: "warning",
});
console.log("dist/sandbox-hub.mjs, dist/bridge.mjs");
