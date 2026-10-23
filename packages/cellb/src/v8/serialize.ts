/**
 * The V8 ValueSerializer wire format (version 15) in TypeScript — what celld stores as the
 * values of Durable Object KV storage (`_cf_KV.v`), so webrun-cells can read celld's cells
 * and write cells celld reads, in browsers too (they have no `v8.serialize`).
 *
 * Covers: undefined, null, booleans, numbers (Smi / double), BigInt, strings (Latin-1 and
 * two-byte), objects, dense and sparse arrays, Date, RegExp, Map, Set, ArrayBuffer and every
 * ArrayBufferView, boxed primitives, object identity (back-references), Error (read).
 * Typed arrays use V8's own encoding ('B' + 'V'), as V8 embedders without a host-object
 * delegate (workerd, Deno, celld) write them — not Node's Buffer host objects.
 */
const VERSION = 15;
const T = {
  pad: 0x00,
  version: 0xff,
  undef: 0x5f,
  nul: 0x30,
  tru: 0x54,
  fal: 0x46,
  int32: 0x49,
  uint32: 0x55,
  double: 0x4e,
  bigint: 0x5a,
  utf8: 0x53,
  oneByte: 0x22,
  twoByte: 0x63,
  ref: 0x5e,
  obj: 0x6f,
  objEnd: 0x7b,
  dense: 0x41,
  denseEnd: 0x24,
  sparse: 0x61,
  sparseEnd: 0x40,
  date: 0x44,
  trueObj: 0x79,
  falseObj: 0x78,
  numObj: 0x6e,
  bigintObj: 0x7a,
  strObj: 0x73,
  regexp: 0x52,
  map: 0x3b,
  mapEnd: 0x3a,
  set: 0x27,
  setEnd: 0x2c,
  ab: 0x42,
  rab: 0x7e,
  view: 0x56,
  error: 0x72,
  theHole: 0x2d,
} as const;

const VIEW_TAGS: [string, number][] = [
  ["Int8Array", 0x62],
  ["Uint8Array", 0x42],
  ["Uint8ClampedArray", 0x43],
  ["Int16Array", 0x77],
  ["Uint16Array", 0x57],
  ["Int32Array", 0x64],
  ["Uint32Array", 0x44],
  ["Float32Array", 0x66],
  ["Float64Array", 0x46],
  ["BigInt64Array", 0x71],
  ["BigUint64Array", 0x51],
  ["DataView", 0x3f],
  ["Float16Array", 0x68],
];

class Writer {
  buf = new Uint8Array(64);
  len = 0;
  ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  varint(n: number | bigint) {
    let v = BigInt(n);
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      this.byte(b);
    } while (v);
  }
  double(d: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, d, true);
    this.bytes(b);
  }
}

export function serialize(value: unknown): Uint8Array {
  const w = new Writer();
  w.byte(T.version);
  w.varint(VERSION);
  const ids = new Map<object, number>();
  let nextId = 0;
  const remember = (o: object) => ids.set(o, nextId++);

  const str = (s: string) => {
    let oneByte = true;
    for (let i = 0; i < s.length; i++)
      if (s.charCodeAt(i) > 0xff) {
        oneByte = false;
        break;
      }
    if (oneByte) {
      w.byte(T.oneByte);
      w.varint(s.length);
      for (let i = 0; i < s.length; i++) w.byte(s.charCodeAt(i));
      return;
    }
    // Two-byte: V8 pads so the UTF-16 data starts at an even offset.
    const byteLength = s.length * 2;
    const lenBytes = new Writer();
    lenBytes.varint(byteLength);
    if ((w.len + 1 + lenBytes.len) % 2 !== 0) w.byte(T.pad);
    w.byte(T.twoByte);
    w.varint(byteLength);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      w.byte(c & 0xff);
      w.byte(c >> 8);
    }
  };
  const num = (n: number) => {
    if (Number.isInteger(n) && n >= -(2 ** 30) && n < 2 ** 30 && !Object.is(n, -0)) {
      w.byte(T.int32);
      w.varint((n << 1) ^ (n >> 31)); // zigzag
    } else {
      w.byte(T.double);
      w.double(n);
    }
  };
  const bigint = (b: bigint) => {
    const neg = b < 0n;
    let m = neg ? -b : b;
    const words: bigint[] = [];
    while (m > 0n) {
      words.push(m & 0xffffffffffffffffn);
      m >>= 64n;
    }
    w.varint(((words.length * 8) << 1) | (neg ? 1 : 0));
    for (const word of words) {
      const b8 = new Uint8Array(8);
      new DataView(b8.buffer).setBigUint64(0, word, true);
      w.bytes(b8);
    }
  };
  const props = (o: object, keys: string[]) => {
    for (const k of keys) {
      const n = Number(k);
      if (String(n >>> 0) === k && n >>> 0 !== 0xffffffff) num(n);
      else str(k);
      write((o as Record<string, unknown>)[k]);
    }
    return keys.length;
  };

  const write = (v: unknown): void => {
    if (v === undefined) return w.byte(T.undef);
    if (v === null) return w.byte(T.nul);
    if (v === true) return w.byte(T.tru);
    if (v === false) return w.byte(T.fal);
    if (typeof v === "number") return num(v);
    if (typeof v === "bigint") {
      w.byte(T.bigint);
      return bigint(v);
    }
    if (typeof v === "string") return str(v);
    if (typeof v !== "object") throw new TypeError(`${String(v)} could not be cloned.`);
    const known = ids.get(v);
    if (known !== undefined) {
      w.byte(T.ref);
      return w.varint(known);
    }
    if (ArrayBuffer.isView(v)) {
      // The buffer first (its id precedes the view's), then the view.
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      remember(v.buffer as object);
      w.byte(T.ab);
      w.varint(v.byteLength);
      w.bytes(bytes);
      remember(v);
      const tag = VIEW_TAGS.find(([name]) => v.constructor.name === name)?.[1];
      if (tag === undefined) throw new TypeError(`${v.constructor.name} could not be cloned.`);
      w.byte(T.view);
      w.byte(tag);
      w.varint(0);
      w.varint(v.byteLength);
      w.varint(0); // flags (length-tracking / backed-by-rab)
      return;
    }
    remember(v);
    if (v instanceof ArrayBuffer) {
      w.byte(T.ab);
      w.varint(v.byteLength);
      return w.bytes(new Uint8Array(v));
    }
    if (v instanceof Date) {
      w.byte(T.date);
      return w.double(v.getTime());
    }
    if (v instanceof RegExp) {
      w.byte(T.regexp);
      str(v.source);
      const flags = "dgimsuyv";
      let bits = 0;
      // V8's JSRegExp::Flags order: g=1 i=2 m=4 y=8 u=16 s=32 d=64 v=256 (linear=128)
      const bit: Record<string, number> = { g: 1, i: 2, m: 4, y: 8, u: 16, s: 32, d: 64, v: 256 };
      for (const f of v.flags) if (flags.includes(f)) bits |= bit[f];
      return w.varint(bits);
    }
    if (v instanceof Map) {
      w.byte(T.map);
      for (const [k, x] of v) {
        write(k);
        write(x);
      }
      w.byte(T.mapEnd);
      return w.varint(v.size * 2);
    }
    if (v instanceof Set) {
      w.byte(T.set);
      for (const x of v) write(x);
      w.byte(T.setEnd);
      return w.varint(v.size);
    }
    if (v instanceof Boolean) return w.byte(v.valueOf() ? T.trueObj : T.falseObj);
    if (v instanceof Number) {
      w.byte(T.numObj);
      return w.double(v.valueOf());
    }
    if (v instanceof String) {
      w.byte(T.strObj);
      return str(v.valueOf());
    }
    if (Array.isArray(v)) {
      const holes = v.length > 0 && Object.keys(v).length < v.length;
      if (holes) {
        w.byte(T.sparse);
        w.varint(v.length);
        const n = props(v, Object.keys(v));
        w.byte(T.sparseEnd);
        w.varint(n);
        return w.varint(v.length);
      }
      w.byte(T.dense);
      w.varint(v.length);
      for (let i = 0; i < v.length; i++) write(v[i]);
      const extra = Object.keys(v).filter((k) => String(Number(k) >>> 0) !== k);
      const n = props(v, extra);
      w.byte(T.denseEnd);
      w.varint(n);
      return w.varint(v.length);
    }
    if (
      typeof (v as { then?: unknown }).then === "function" ||
      v instanceof WeakMap ||
      v instanceof WeakSet
    )
      throw new TypeError(`#<${v.constructor?.name ?? "Object"}> could not be cloned.`);
    w.byte(T.obj);
    const n = props(v, Object.keys(v));
    w.byte(T.objEnd);
    return w.varint(n);
  };
  write(value);
  return w.buf.slice(0, w.len);
}

export function deserialize(bytes: Uint8Array): unknown {
  let o = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objs: unknown[] = [];
  const u8 = () => bytes[o++];
  const varint = (): number => {
    let r = 0n;
    let shift = 0n;
    for (;;) {
      const b = u8();
      r |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return Number(r);
  };
  const double = () => {
    const d = dv.getFloat64(o, true);
    o += 8;
    return d;
  };
  const tag = () => {
    let t = u8();
    while (t === T.pad) t = u8();
    return t;
  };
  if (u8() !== T.version) throw new Error("v8: missing version header");
  const version = varint();
  if (version < 13) throw new Error(`v8: unsupported version ${version}`);

  const bigint = (): bigint => {
    const bitfield = varint();
    const n = bitfield >> 1;
    let r = 0n;
    for (let i = 0; i < n; i++) r |= BigInt(bytes[o + i]) << BigInt(8 * i);
    o += n;
    return bitfield & 1 ? -r : r;
  };
  const strBody = (t: number): string => {
    const n = varint();
    const b = bytes.subarray(o, o + n);
    o += n;
    if (t === T.oneByte) return String.fromCharCode(...b);
    if (t === T.utf8) return new TextDecoder().decode(b);
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    return s;
  };
  const props = (target: Record<string, unknown>, end: number) => {
    for (;;) {
      const t = tag();
      if (t === end) {
        varint(); // property count
        return;
      }
      o--;
      const k = read();
      target[String(k)] = read();
    }
  };
  const viewOf = (buffer: ArrayBuffer): unknown => {
    const sub = u8();
    const offset = varint();
    const length = varint();
    if (version >= 14) varint(); // flags
    const name = VIEW_TAGS.find(([, t]) => t === sub)?.[0];
    if (!name) throw new Error(`v8: unknown view tag ${sub}`);
    const Ctor = (globalThis as Record<string, any>)[name];
    const size = name === "DataView" ? 1 : Ctor.BYTES_PER_ELEMENT;
    const view =
      name === "DataView"
        ? new DataView(buffer, offset, length)
        : new Ctor(buffer, offset, length / size);
    objs.push(view);
    return view;
  };
  const read = (): unknown => {
    const t = tag();
    switch (t) {
      case T.undef:
        return undefined;
      case T.nul:
        return null;
      case T.tru:
        return true;
      case T.fal:
        return false;
      case T.int32: {
        const z = varint();
        return (z >>> 1) ^ -(z & 1);
      }
      case T.uint32:
        return varint();
      case T.double:
        return double();
      case T.bigint:
        return bigint();
      case T.oneByte:
      case T.twoByte:
      case T.utf8:
        return strBody(t);
      case T.ref:
        return objs[varint()];
      case T.obj: {
        const r: Record<string, unknown> = {};
        objs.push(r);
        props(r, T.objEnd);
        return r;
      }
      case T.dense: {
        const n = varint();
        const a: unknown[] = new Array(n);
        objs.push(a);
        for (let i = 0; i < n; i++) {
          const peek = bytes[o];
          if (peek === T.theHole) {
            o++;
            continue;
          }
          a[i] = read();
        }
        props(a as unknown as Record<string, unknown>, T.denseEnd);
        varint(); // length
        return a;
      }
      case T.sparse: {
        const n = varint();
        const a: unknown[] = new Array(n);
        objs.push(a);
        props(a as unknown as Record<string, unknown>, T.sparseEnd);
        varint();
        return a;
      }
      case T.date: {
        const d = new Date(double());
        objs.push(d);
        return d;
      }
      case T.trueObj:
      case T.falseObj: {
        const b = new Boolean(t === T.trueObj);
        objs.push(b);
        return b;
      }
      case T.numObj: {
        const n = new Number(double());
        objs.push(n);
        return n;
      }
      case T.bigintObj: {
        const b = Object(bigint());
        objs.push(b);
        return b;
      }
      case T.strObj: {
        const s = new String(read() as string);
        objs.push(s);
        return s;
      }
      case T.regexp: {
        const id = objs.length;
        objs.push(null);
        const source = read() as string;
        const bits = varint();
        const map: [number, string][] = [
          [64, "d"],
          [1, "g"],
          [2, "i"],
          [4, "m"],
          [32, "s"],
          [16, "u"],
          [256, "v"],
          [8, "y"],
        ];
        const r = new RegExp(
          source,
          map
            .filter(([b]) => bits & b)
            .map(([, f]) => f)
            .join(""),
        );
        objs[id] = r;
        return r;
      }
      case T.map: {
        const m = new Map();
        objs.push(m);
        for (;;) {
          if (bytes[o] === T.mapEnd) {
            o++;
            varint();
            return m;
          }
          const k = read();
          m.set(k, read());
        }
      }
      case T.set: {
        const s = new Set();
        objs.push(s);
        for (;;) {
          if (bytes[o] === T.setEnd) {
            o++;
            varint();
            return s;
          }
          s.add(read());
        }
      }
      case T.ab:
      case T.rab: {
        const n = varint();
        if (t === T.rab) varint(); // max byte length
        const buffer = bytes.slice(o, o + n).buffer;
        o += n;
        objs.push(buffer);
        if (bytes[o] === T.view) {
          o++;
          return viewOf(buffer);
        }
        return buffer;
      }
      case T.error: {
        let message = "";
        let name = "Error";
        let stack: string | undefined;
        const proto: Record<number, string> = {
          69: "EvalError",
          82: "RangeError",
          70: "ReferenceError",
          83: "SyntaxError",
          84: "TypeError",
          85: "URIError",
        };
        for (;;) {
          const s = u8();
          if (s === 0x2e) break; // '.' end
          if (proto[s]) name = proto[s];
          else if (s === 0x6d)
            message = read() as string; // 'm'
          else if (s === 0x73)
            stack = read() as string; // 's'
          else if (s === 0x63) read(); // 'c' cause
        }
        const Ctor = (globalThis as Record<string, any>)[name] ?? Error;
        const e = new Ctor(message);
        if (stack) e.stack = stack;
        objs.push(e);
        return e;
      }
      default:
        throw new Error(`v8: unsupported tag 0x${t.toString(16)} at ${o - 1}`);
    }
  };
  return read();
}
