/**
 * workerd extensions used by Miniflare's simulator Durable Objects, for browsers/Node:
 *  - `IdentityTransformStream`: a byte pass-through TransformStream;
 *  - `ReadableStreamBYOBReader#readAtLeast(min, view)`: read until `min` bytes or EOF.
 * (Miniflare 2 shipped the same polyfills in TypeScript: packages/core/src/standards/streams.ts.)
 */
const g = globalThis as Record<string, unknown>;

if (typeof g.IdentityTransformStream === "undefined") {
  g.IdentityTransformStream = class IdentityTransformStream extends (
    TransformStream<Uint8Array, Uint8Array>
  ) {};
}

const BYOB = (
  globalThis as unknown as { ReadableStreamBYOBReader?: { prototype: Record<string, unknown> } }
).ReadableStreamBYOBReader;
if (BYOB && typeof BYOB.prototype.readAtLeast !== "function") {
  BYOB.prototype.readAtLeast = async function readAtLeast(
    this: ReadableStreamBYOBReader,
    min: number,
    view: Uint8Array,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let offset = 0;
    let buffer = view.buffer;
    while (offset < min) {
      const { value, done } = await this.read(
        new Uint8Array(buffer as ArrayBuffer, view.byteOffset + offset, view.byteLength - offset),
      );
      if (value) {
        buffer = value.buffer;
        offset += value.byteLength;
      }
      if (done)
        return { value: new Uint8Array(buffer, view.byteOffset, offset), done: offset === 0 };
    }
    return { value: new Uint8Array(buffer, view.byteOffset, offset), done: false };
  };
}

export {};
