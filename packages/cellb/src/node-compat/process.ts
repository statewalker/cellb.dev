/** A minimal `process` for browsers (nodejs_compat): env, nextTick, platform data. */
export const process = {
  env: {} as Record<string, string>,
  argv: [] as string[],
  platform: "browser",
  version: "v22.0.0",
  versions: { node: "22.0.0" },
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => fn(...args)),
  cwd: () => "/",
  emitWarning: () => {},
};
export default process;
