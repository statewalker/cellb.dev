import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** 64-hex-char object id. idFromName is SYNCHRONOUS (as on CF), hence noble instead of crypto.subtle. */
export class DurableObjectId {
  readonly #hex: string;
  readonly name?: string;
  constructor(hex: string, name?: string) {
    if (!/^[0-9a-f]{64}$/.test(hex))
      throw new TypeError("Invalid Durable Object ID: must be 64 hex digits");
    this.#hex = hex;
    if (name !== undefined) this.name = name;
  }
  toString(): string {
    return this.#hex;
  }
  equals(other: DurableObjectId): boolean {
    return other.toString() === this.#hex;
  }
}

/**
 * Ids as celld derives them (engine_api.rs), so one name reaches the same object id on
 * celld and on webrun-cells: namespace key `cells:v1:<len(script)>:<script>:<class>`;
 * key = SHA-256(namespace key); id = HMAC(key, name)[0..16] ‖ HMAC(key, first half)[0..16].
 * The second half authenticates the first, so idFromString() rejects ids of other namespaces.
 */
export function namespaceKey(scriptName: string, className: string): string {
  return `cells:v1:${scriptName.length}:${scriptName}:${className}`;
}

const keys = new Map<string, Uint8Array>();
const keyOf = (ns: string) => {
  let k = keys.get(ns);
  if (!k) {
    k = sha256(new TextEncoder().encode(ns));
    keys.set(ns, k);
  }
  return k;
};
const half = (key: Uint8Array, data: Uint8Array) => hmac(sha256, key, data).subarray(0, 16);
const withSuffix = (ns: string, first: Uint8Array) => {
  const id = new Uint8Array(32);
  id.set(first, 0);
  id.set(half(keyOf(ns), first), 16);
  return bytesToHex(id);
};

export function idFromName(ns: string, name: string): DurableObjectId {
  const hex = withSuffix(ns, half(keyOf(ns), new TextEncoder().encode(name)));
  // ctx.id.name holds names up to 1024 UTF-8 bytes, as on Cloudflare and celld.
  return new DurableObjectId(
    hex,
    new TextEncoder().encode(name).byteLength <= 1024 ? name : undefined,
  );
}

export function newUniqueId(ns: string): DurableObjectId {
  const first = new Uint8Array(16);
  crypto.getRandomValues(first);
  return new DurableObjectId(withSuffix(ns, first));
}

/** idFromString(): 64 hex digits whose second half authenticates the first for `ns`. */
export function validateId(ns: string, hex: string): DurableObjectId {
  const id = new DurableObjectId(hex);
  if (withSuffix(ns, hexToBytes(hex.slice(0, 32))) !== hex)
    throw new TypeError("Durable Object ID is not valid for this namespace");
  return id;
}
