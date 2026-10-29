/**
 * `node:crypto` subset for browsers (nodejs_compat): hashes, HMAC, random, timingSafeEqual, and
 * public `KeyObject`s (`createPublicKey`) without signature checks.
 */
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

const OIDS: [number[], string][] = [
  [[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01], "rsa"],
  [[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01], "ec"],
  [[0x2b, 0x65, 0x70], "ed25519"],
  [[0x2b, 0x65, 0x71], "ed448"],
];
const contains = (hay: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/**
 * A public key as `createPublicKey` returns it: its type and its bytes, exportable as DER or
 * PEM. Libraries build these when they load (sigstore's trust roots, in EmDash's plugin
 * registry); signatures are checked through `verify`, which is not available here.
 */
export class KeyObject {
  readonly type = "public";
  readonly asymmetricKeyType: string | undefined;
  readonly #der: Uint8Array;
  readonly #format: "spki" | "pkcs1";
  constructor(der: Uint8Array, format: "spki" | "pkcs1") {
    this.#der = der;
    this.#format = format;
    this.asymmetricKeyType =
      format === "pkcs1" ? "rsa" : OIDS.find(([oid]) => contains(der.subarray(0, 32), oid))?.[1];
  }
  export(opts: { format?: "der" | "pem"; type?: string } = {}): Buffer | string {
    if (opts.format === "pem") {
      const label = this.#format === "pkcs1" ? "RSA PUBLIC KEY" : "PUBLIC KEY";
      const b64 = Buffer.from(this.#der).toString("base64").replace(/.{64}/g, "$&\n");
      return `-----BEGIN ${label}-----\n${b64.replace(/\n$/, "")}\n-----END ${label}-----\n`;
    }
    return Buffer.from(this.#der);
  }
  equals(other: KeyObject): boolean {
    const a = this.export() as Buffer;
    const b = other.export() as Buffer;
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

type KeyInput =
  | string
  | Uint8Array
  | KeyObject
  | { key: string | Uint8Array; format?: "pem" | "der"; type?: "spki" | "pkcs1" };

export function createPublicKey(input: KeyInput): KeyObject {
  if (input instanceof KeyObject) return input;
  const spec = typeof input === "string" || input instanceof Uint8Array ? { key: input } : input;
  if (typeof spec.key === "string" || spec.format === "pem") {
    const pem = typeof spec.key === "string" ? spec.key : Buffer.from(spec.key).toString("utf8");
    const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
    if (!m) throw new TypeError("createPublicKey: not a PEM public key");
    if (!/PUBLIC KEY/.test(m[1]))
      throw new Error(`createPublicKey: ${m[1]} is not supported in browsers (nodejs_compat)`);
    return new KeyObject(
      new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ""), "base64")),
      m[1] === "RSA PUBLIC KEY" ? "pkcs1" : "spki",
    );
  }
  return new KeyObject(new Uint8Array(spec.key), spec.type === "pkcs1" ? "pkcs1" : "spki");
}

const noVerify = (): never => {
  throw new Error(
    "node:crypto signature verification is not available in browsers (nodejs_compat)",
  );
};
export function verify(..._args: unknown[]): boolean {
  return noVerify();
}
export function createVerify(_algorithm: string) {
  return {
    update() {
      return this;
    },
    verify: noVerify,
  };
}

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto.subtle;
export default {
  createHash,
  createHmac,
  randomUUID,
  randomBytes,
  timingSafeEqual,
  KeyObject,
  createPublicKey,
  verify,
  createVerify,
  webcrypto,
  subtle,
};
