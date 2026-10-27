/**
 * `node:fs` for browsers (nodejs_compat): there is no file system, so every call fails with
 * `ENOENT` (as for a missing file) and `existsSync` is false. Code that probes for optional
 * files, such as an SDK reading `/proc/self/environ` inside a `try`, keeps working.
 */
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

export const existsSync = (_path?: unknown) => false;
export const readFileSync = missing("open");
export const writeFileSync = missing("open");
export const statSync = missing("stat");
export const lstatSync = missing("lstat");
export const readdirSync = missing("scandir");
export const mkdirSync = missing("mkdir");
export const promises = {
  readFile: missingAsync("open"),
  writeFile: missingAsync("open"),
  stat: missingAsync("stat"),
  lstat: missingAsync("lstat"),
  readdir: missingAsync("scandir"),
  mkdir: missingAsync("mkdir"),
  access: missingAsync("access"),
};

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  promises,
};
