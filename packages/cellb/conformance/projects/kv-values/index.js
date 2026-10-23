// Values of every kind written with ctx.storage.put and described when read back — used to
// check that celld and webrun-cells read each other's stored values (V8 serialization).
import { DurableObject } from "cloudflare:workers";

const describe = (v) => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (v instanceof Date) return `Date:${v.toISOString()}`;
  if (v instanceof Map) return `Map:${JSON.stringify([...v].map(([k, x]) => [k, describe(x)]))}`;
  if (v instanceof Set) return `Set:${JSON.stringify([...v].map(describe))}`;
  if (v instanceof RegExp) return `RegExp:${v.source}/${v.flags}`;
  if (v instanceof ArrayBuffer) return `ArrayBuffer:${[...new Uint8Array(v)]}`;
  if (v instanceof DataView) return `DataView:${v.byteLength}:${v.getUint8(0)}`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}:${[...v].map(String)}`;
  if (typeof v === "bigint") return `bigint:${v}`;
  if (Array.isArray(v)) return `Array(${v.length}):${JSON.stringify(v.map(describe))}`;
  if (typeof v === "object") return `Object:${JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x)])))}`;
  return `${typeof v}:${String(v)}`;
};

const VALUES = () => ({
  int: 42,
  neg: -7,
  big: 2 ** 40,
  float: 3.25,
  str: "héllo",
  wide: "日本 ✓ 😀",
  bool: true,
  nul: null,
  undef: undefined,
  bigint: 12345678901234567890n,
  date: new Date(1700000000000),
  arr: [1, "two", [3]],
  sparse: (() => {
    const a = [];
    a[3] = "x";
    return a;
  })(),
  obj: { a: 1, nested: { b: [true, null] } },
  map: new Map([["k", 1], [2, "v"]]),
  set: new Set([1, "s"]),
  re: /a+b/gi,
  ab: new Uint8Array([1, 2, 255]).buffer,
  u8: new Uint8Array([10, 20, 30]),
  i16: new Int16Array([-1, 500]),
  f64: new Float64Array([1.5, -2.25]),
  dv: new DataView(new Uint8Array([7, 8]).buffer),
});

export class Store extends DurableObject {
  async write() {
    await this.ctx.storage.put(VALUES());
    return "written";
  }
  async read() {
    const keys = Object.keys(VALUES());
    const got = await this.ctx.storage.get(keys);
    return Object.fromEntries(keys.map((k) => [k, describe(got.get(k))]));
  }
}

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    return Response.json(await env.S.getByName("values")[op]());
  },
};
