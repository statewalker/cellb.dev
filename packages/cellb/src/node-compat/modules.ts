/**
 * nodejs_compat in browsers: `node:*` specifiers → polyfill modules. Used by the browser
 * bundler (esbuild aliases) and by the in-browser module server (host registry entries).
 * On Node hosts `node:*` stays the real Node.js module.
 */
export const NODE_POLYFILL_PACKAGES: Record<string, string> = {
  "node:buffer": "buffer",
  "node:events": "events",
  "node:path": "path-browserify",
  "node:util": "util",
};
/** Implemented in this package (src/node-compat). */
export const NODE_POLYFILL_FILES: Record<string, string> = {
  "node:crypto": "crypto.ts",
  "node:async_hooks": "async_hooks.ts",
  "node:process": "process.ts",
};
