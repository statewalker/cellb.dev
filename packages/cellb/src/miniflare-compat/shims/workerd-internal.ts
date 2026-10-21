/**
 * Stand-ins for workerd's internal modules imported by its TypeScript binding
 * clients (workerd src/cloudflare/internal/*-api.ts):
 *  - "cloudflare-internal:wrapped-binding": base class of wrapped bindings;
 *  - "cloudflare-internal:tracing-helpers": spans (no-op here).
 */
export class WrappedBinding {
  // biome-ignore lint/complexity/noUselessConstructor: mirrors workerd's signature
  constructor(_inner?: object) {}
}
export default { WrappedBinding };

const noopSpan = {
  setAttribute() {},
  setAttributes() {},
  end() {},
};
export function withSpan<T>(_name: string, fn: (span: typeof noopSpan) => T): T {
  return fn(noopSpan);
}
export function startSpan<T>(_name: string, fn: (span: typeof noopSpan) => T): T {
  return fn(noopSpan);
}
