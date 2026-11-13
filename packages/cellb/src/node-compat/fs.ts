/**
 * `node:fs` for browsers (nodejs_compat): there is no file system, so every call fails with
 * `ENOENT` (as for a missing file) and `existsSync` is false. Code that probes for optional
 * files, such as an SDK reading `/proc/self/environ` inside a `try`, keeps working. The one
 * directory there is is workerd's `/bundle`, read-only: the bundle's own non-JS modules
 * (bundle-files.ts).
 */
import { bundleFs } from "./bundle-files.js";

const missing = (op: string) => (path?: unknown) => {
  throw Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${String(path)}'`), {
    code: "ENOENT",
    syscall: op,
    path,
  });
};
const missingAsync =
  (op: string) =>
  async (path?: unknown): Promise<never> =>
    missing(op)(path);
const missingCallback =
  (op: string) =>
  (path: unknown, ...rest: unknown[]) => {
    const cb = rest.pop() as (e: unknown) => void;
    try {
      missing(op)(path);
    } catch (e) {
      queueMicrotask(() => cb(e));
    }
  };

const none = {
  existsSync: (_path?: unknown) => false,
  readFileSync: missing("open"),
  statSync: missing("stat"),
  lstatSync: missing("lstat"),
  readdirSync: missing("scandir"),
  accessSync: missing("access"),
  readFile: missingCallback("open"),
  stat: missingCallback("stat"),
  lstat: missingCallback("lstat"),
  readdir: missingCallback("scandir"),
  access: missingCallback("access"),
  promises: {
    readFile: missingAsync("open"),
    writeFile: missingAsync("open"),
    stat: missingAsync("stat"),
    lstat: missingAsync("lstat"),
    readdir: missingAsync("scandir"),
    mkdir: missingAsync("mkdir"),
    access: missingAsync("access"),
  },
};
const fs = bundleFs(none) as typeof none;

export const existsSync = fs.existsSync;
export const readFileSync = fs.readFileSync;
export const writeFileSync = missing("open");
export const statSync = fs.statSync;
export const lstatSync = fs.lstatSync;
export const readdirSync = fs.readdirSync;
export const accessSync = fs.accessSync;
export const mkdirSync = missing("mkdir");
export const readFile = fs.readFile;
export const stat = fs.stat;
export const lstat = fs.lstat;
export const readdir = fs.readdir;
export const access = fs.access;
export const promises = fs.promises;

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  readdirSync,
  accessSync,
  mkdirSync,
  readFile,
  stat,
  lstat,
  readdir,
  access,
  promises,
};
