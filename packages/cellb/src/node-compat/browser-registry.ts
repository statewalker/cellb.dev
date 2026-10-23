// nodejs_compat for the in-browser module server: the polyfill modules as registry entries
// (imported here so the browser bundler includes them in the worker that runs Worker code).
// An entry is the module's default export, carrying its named exports as properties: the
// module server's proxy serves the entry itself as `default` (so `import assert from
// "node:assert"` must be callable) and its keys as the named exports.
import assert from "assert";
import { Buffer } from "buffer";
import EventEmitter from "events";
import path from "path-browserify";
import util from "util";
import * as async_hooks from "./async_hooks.js";
import * as crypto from "./crypto.js";
import { process } from "./process.js";

const modules: Record<string, unknown> = {
  "node:assert": assert,
  "node:buffer": { Buffer, default: { Buffer } },
  "node:events": EventEmitter, // npm `events`: EventEmitter.EventEmitter, EventEmitter.once
  "node:path": { ...path, default: path },
  "node:util": { ...util, default: util },
  "node:crypto": { ...crypto },
  "node:async_hooks": { ...async_hooks },
  "node:process": process,
};

/** Registry entries: each module under its served alias (see `nodeAlias` in project/site.ts). */
export const nodeRegistryEntries: Record<string, unknown> = {
  ...Object.fromEntries(Object.entries(modules).map(([k, v]) => [`cells-node-${k.slice(5)}`, v])),
  Buffer,
  process,
};
