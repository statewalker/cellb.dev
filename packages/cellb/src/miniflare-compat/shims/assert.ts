/** Minimal `node:assert` for code written for workerd (Miniflare's simulators). */
export class AssertionError extends Error {
  constructor(message?: string) {
    super(message ?? "Assertion failed");
    this.name = "AssertionError";
  }
}
function assert(value: unknown, message?: string | Error): asserts value {
  if (!value) throw message instanceof Error ? message : new AssertionError(message);
}
assert.ok = assert;
assert.strictEqual = (a: unknown, b: unknown, message?: string) => {
  if (!Object.is(a, b))
    throw new AssertionError(message ?? `Expected ${String(a)} to be ${String(b)}`);
};
assert.fail = (message?: string): never => {
  throw new AssertionError(message);
};
assert.AssertionError = AssertionError;
export default assert;
export const ok = assert;
export const strictEqual = assert.strictEqual;
