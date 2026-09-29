import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

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

export function idFromName(namespaceKey: string, name: string): DurableObjectId {
  return new DurableObjectId(
    bytesToHex(sha256(new TextEncoder().encode(`${namespaceKey}\u0000${name}`))),
    name,
  );
}

export function newUniqueId(): DurableObjectId {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return new DurableObjectId(bytesToHex(b));
}
