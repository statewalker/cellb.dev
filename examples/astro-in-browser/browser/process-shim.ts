// The builder realm's `process`, before anything reads it (cellb's npm `util` polyfill, and
// build-time code that reads `process.env`): imported first by builder-worker.ts.
const g = globalThis as { process?: Record<string, unknown> };
g.process ??= {
  env: {},
  cwd: () => "/app",
  platform: "browser",
  versions: {},
  argv: [],
  browser: true,
  nextTick: (f: () => void) => queueMicrotask(f),
};
