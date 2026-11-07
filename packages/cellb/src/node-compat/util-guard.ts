// The npm `util` polyfill (and `assert`, which imports it) reads `process.env.NODE_DEBUG` while it
// is evaluated. A realm without nodejs_compat has no `process`, and must not get one: until
// `browser-registry.ts` has loaded, `process` is a placeholder, which it then removes
// (`releaseUtilGuard`). A realm that has `process` keeps it.
const g = globalThis as { process?: unknown };
const placeholder = g.process === undefined ? { env: {} } : undefined;
if (placeholder) g.process = placeholder;

/** Removes the placeholder `process`, unless something replaced it since. */
export function releaseUtilGuard(): void {
  if (placeholder && g.process === placeholder) delete g.process;
}
