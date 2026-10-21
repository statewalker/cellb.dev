/** `node:crypto` subset for browsers (nodejs_compat): hashes, HMAC, random, timingSafeEqual. */
import { hmac } from "@noble/hashes/hmac";
import { md5, sha1 } from "@noble/hashes/legacy";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2";
import { Buffer } from "buffer";

const HASHES = { md5, sha1, sha256, sha384, sha512 } as const;
type Algo = keyof typeof HASHES;
const algo = (name: string): (typeof HASHES)[Algo] => {
  const h = HASHES[name.toLowerCase().replace("-", "") as Algo];
  if (!h) throw new Error(`Digest method not supported: ${name}`);
  return h;
};
const bytes = (data: string | Uint8Array, enc?: BufferEncoding) =>
  typeof data === "string" ? new Uint8Array(Buffer.from(data, enc ?? "utf8")) : data;

class Hash {
  #parts: Uint8Array[] = [];
  constructor(private readonly fn: (m: Uint8Array) => Uint8Array) {}
  update(data: string | Uint8Array, enc?: BufferEncoding): this {
    this.#parts.push(bytes(data, enc));
    return this;
  }
  digest(enc?: BufferEncoding): Buffer | string {
    const all = Buffer.concat(this.#parts);
    const out = Buffer.from(this.fn(new Uint8Array(all)));
    return enc ? out.toString(enc) : out;
  }
}

export function createHash(name: string) {
  return new Hash(algo(name));
}
export function createHmac(name: string, key: string | Uint8Array) {
  const h = algo(name);
  return new Hash((m) => hmac(h as never, bytes(key), m));
}
export function randomUUID(): string {
  return crypto.randomUUID();
}
export function randomBytes(n: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength)
    throw new RangeError("Input buffers must have the same byte length");
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto.subtle;
export default {
  createHash,
  createHmac,
  randomUUID,
  randomBytes,
  timingSafeEqual,
  webcrypto,
  subtle,
};
