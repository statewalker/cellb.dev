/**
 * workerd's `performance` clock is coarse: `timeOrigin` and `now()` are whole
 * milliseconds (Spectre mitigation). Miniflare's BlobStore relies on it
 * (`BigInt(performance.timeOrigin + performance.now())`), which throws on the
 * fractional values of browsers and Node. Injected by esbuild as the `performance`
 * identifier of the vendored simulators only — the real global is untouched.
 */
const real = globalThis.performance;
export const performance = {
  get timeOrigin(): number {
    return Math.floor(real.timeOrigin);
  },
  now(): number {
    return Math.floor(real.now());
  },
};
