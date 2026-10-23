import v8 from "node:v8";
import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "../src/v8/serialize.js";

// Byte-for-byte against Node's own V8 serializer (the same engine celld's isolates use), for
// every value kind whose encoding Node does not override (Node writes typed arrays as its
// own host objects; V8 embedders without that delegate — celld — use 'B' + 'V').
const corpus: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["booleans", [true, false]],
  ["small ints", [0, 1, -1, 5, 1073741823, -1073741824]],
  ["doubles", [1.5, -0, 2 ** 40, Number.NaN, Number.POSITIVE_INFINITY, 1e-300]],
  ["bigints", [0n, 1n, -1n, 2n ** 64n, -(2n ** 127n) + 5n]],
  ["latin1", "héllo wörld"],
  ["two-byte", "ünïcødé ✓ 日本 😀"],
  ["empty string", ""],
  ["object", { a: 1, b: { c: [1, 2, "x"] }, "1": "numeric key", "": "empty key" }],
  ["dense array with props", Object.assign([1, 2, 3], { extra: true })],
  [
    "sparse array",
    (() => {
      const a: unknown[] = [];
      a[5] = "five";
      a[100] = 1;
      return a;
    })(),
  ],
  ["date", new Date(1234567890123)],
  ["regexp", /ab+c/gimsuy],
  [
    "map",
    new Map<unknown, unknown>([
      ["k", 1],
      [2, { x: 1 }],
    ]),
  ],
  ["set", new Set([1, "two", 3n])],
  ["boxed", [new Boolean(true), new Number(2.5), new String("s")]],
  [
    "shared references",
    (() => {
      const shared = { s: 1 };
      return { a: shared, b: shared, c: [shared] };
    })(),
  ],
  ["ArrayBuffer", new Uint8Array([1, 2, 3, 250]).buffer],
];

describe("P12 V8 value serialization in TypeScript", () => {
  for (const [name, value] of corpus) {
    it(`${name}: same bytes as Node's V8, and back`, () => {
      const ours = serialize(value);
      expect(Buffer.from(ours).toString("hex")).toBe(v8.serialize(value).toString("hex"));
      expect(deserialize(new Uint8Array(v8.serialize(value)))).toEqual(value);
    });
  }

  it("typed arrays and DataView round-trip with V8's native encoding", () => {
    const values = [
      new Uint8Array([1, 2, 3]),
      new Int16Array([-1, 300]),
      new Float64Array([1.5, -2]),
      new BigInt64Array([1n, -5n]),
      new DataView(new Uint8Array([9, 8, 7]).buffer),
      { nested: new Uint8Array([4, 5]) },
    ];
    for (const v of values) {
      const back = deserialize(serialize(v));
      expect(back).toEqual(v);
    }
  });

  it("refuses functions and symbols like structured clone", () => {
    expect(() => serialize(() => 1)).toThrow(/could not be cloned/);
    expect(() => serialize({ f: Symbol("x") })).toThrow(/could not be cloned/);
  });
});
