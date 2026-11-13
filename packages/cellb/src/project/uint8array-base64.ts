/**
 * `Uint8Array.prototype.toBase64` / `toHex` and `Uint8Array.fromBase64` / `fromHex` (ES2026,
 * which workerd has) where the engine lacks them: Node 22, and browsers before them. A prototype
 * method cannot be substituted per bundle as the other Workers globals are, so the realm's own
 * `Uint8Array` gets them; an engine that has them keeps its own.
 */

type Alphabet = "base64" | "base64url";
interface ToBase64Options {
  alphabet?: Alphabet;
  omitPadding?: boolean;
}
interface FromBase64Options {
  alphabet?: Alphabet;
  lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64(bytes: Uint8Array, opts: ToBase64Options = {}): string {
  const table = alphabetOf(opts.alphabet) === "base64url" ? B64URL : B64;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += table[n >> 18] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
  }
  const pad = opts.omitPadding ? "" : "=";
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    out += table[n >> 18] + table[(n >> 12) & 63] + pad + pad;
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += table[n >> 18] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + pad;
  }
  return out;
}

function fromBase64(input: string, opts: FromBase64Options = {}): Uint8Array {
  if (typeof input !== "string") throw new TypeError("fromBase64: the input must be a string");
  const table = alphabetOf(opts.alphabet) === "base64url" ? B64URL : B64;
  const strict = opts.lastChunkHandling === "strict";
  const s = input.replace(/[\t\n\f\r ]/g, "");
  const body = s.replace(/=+$/, "");
  const padding = s.length - body.length;
  if (padding > 2 || (padding > 0 && s.length % 4 !== 0) || body.length % 4 === 1)
    throw new SyntaxError("fromBase64: invalid base64 string");
  if (strict && body.length % 4 !== 0 && padding === 0)
    throw new SyntaxError("fromBase64: missing padding");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of body) {
    const v = table.indexOf(c);
    if (v < 0) throw new SyntaxError(`fromBase64: invalid character ${JSON.stringify(c)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (strict && bits > 0 && (acc & ((1 << bits) - 1)) !== 0)
    throw new SyntaxError("fromBase64: non-zero padding bits");
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(input: string): Uint8Array {
  if (typeof input !== "string") throw new TypeError("fromHex: the input must be a string");
  if (input.length % 2 !== 0 || /[^0-9a-fA-F]/.test(input))
    throw new SyntaxError("fromHex: invalid hex string");
  const out = new Uint8Array(input.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function alphabetOf(alphabet: unknown): Alphabet {
  if (alphabet === undefined || alphabet === "base64" || alphabet === "base64url")
    return alphabet ?? "base64";
  throw new TypeError(`unknown base64 alphabet ${JSON.stringify(alphabet)}`);
}

const method = (value: unknown) => ({ value, writable: true, configurable: true });
const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
const ctor = Uint8Array as unknown as Record<string, unknown>;
if (typeof proto.toBase64 !== "function")
  Object.defineProperty(
    proto,
    "toBase64",
    method(function (this: Uint8Array, opts?: ToBase64Options) {
      return toBase64(this, opts);
    }),
  );
if (typeof proto.toHex !== "function")
  Object.defineProperty(
    proto,
    "toHex",
    method(function (this: Uint8Array) {
      return toHex(this);
    }),
  );
if (typeof ctor.fromBase64 !== "function")
  Object.defineProperty(ctor, "fromBase64", method(fromBase64));
if (typeof ctor.fromHex !== "function") Object.defineProperty(ctor, "fromHex", method(fromHex));
