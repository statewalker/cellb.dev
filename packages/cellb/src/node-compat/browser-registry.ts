// nodejs_compat for the in-browser module server: the polyfill modules as registry entries
// (imported here so the browser bundler includes them in the worker that runs Worker code).
// The npm polyfills are CommonJS: each entry exposes the named exports Node has, plus default.
import { Buffer } from "buffer";
import EventEmitter from "events";
import path from "path-browserify";
import util from "util";
import * as async_hooks from "./async_hooks.js";
import * as crypto from "./crypto.js";
import { process } from "./process.js";

const modules: Record<string, unknown> = {
  "node:buffer": { Buffer, default: { Buffer } },
  "node:events": {
    EventEmitter,
    once: (EventEmitter as unknown as { once: unknown }).once,
    default: EventEmitter,
  },
  "node:path": { ...path, default: path },
  "node:util": { ...util, default: util },
  "node:crypto": { ...crypto },
  "node:async_hooks": { ...async_hooks },
  "node:process": { process, default: process },
};

/** Registry entries: each module under its served alias (see `nodeAlias` in project/site.ts). */
export const nodeRegistryEntries: Record<string, unknown> = {
  ...Object.fromEntries(Object.entries(modules).map(([k, v]) => [`cells-node-${k.slice(5)}`, v])),
  Buffer,
  process,
};
