/** A minimal `process` for browsers (nodejs_compat): env, nextTick, platform data. */
export const process = {
  // The project's text `vars` when nodejs_compat populates process.env (browserProjectRuntime
  // sets this global before the code, and with it this module, is evaluated).
  env: ((globalThis as { __cellsProcessEnv?: Record<string, string> }).__cellsProcessEnv ??
    {}) as Record<string, string>,
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
