import type { ValueCodec } from "../ports.js";

/**
 * Tagged-JSON codec covering the structured-clone types used in practice
 * (Date, Map, Set, bigint, ArrayBuffer, typed arrays, undefined).
 * Placeholder for webrun-msgpack; CF itself uses V8 serialization.
 */
export const jsonCodec: ValueCodec = {
  encode(value) {
    return new TextEncoder().encode(JSON.stringify(tag(value)));
  },
  decode(bytes) {
    return untag(JSON.parse(new TextDecoder().decode(bytes)));
  },
};

const T = "$t";
function tag(v: unknown): unknown {
  if (v === undefined) return { [T]: "u" };
  if (typeof v === "bigint") return { [T]: "n", v: v.toString() };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return { [T]: "d", v: v.getTime() };
  if (v instanceof ArrayBuffer) return { [T]: "b", v: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v))
    return {
      [T]: "v",
      k: v.constructor.name,
      v: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)),
    };
  if (v instanceof Map) return { [T]: "m", v: [...v].map(([k, x]) => [tag(k), tag(x)]) };
  if (v instanceof Set) return { [T]: "s", v: [...v].map(tag) };
  if (Array.isArray(v)) return v.map(tag);
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = tag(x);
  if (T in o) return { [T]: "o", v: o };
  return o;
}
function untag(v: any): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(untag);
  switch (v[T]) {
    case "u":
      return undefined;
    case "n":
      return BigInt(v.v);
    case "d":
      return new Date(v.v);
    case "b": {
      const u = unb64(v.v);
      return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    }
    case "v": {
      const u = unb64(v.v);
      const C = (globalThis as any)[v.k] ?? Uint8Array;
      return new C(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    }
    case "m":
      return new Map(v.v.map(([k, x]: any) => [untag(k), untag(x)]));
    case "s":
      return new Set(v.v.map(untag));
    case "o":
      return Object.fromEntries(Object.entries(v.v).map(([k, x]) => [k, untag(x)]));
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untag(x)]));
}
function b64(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
