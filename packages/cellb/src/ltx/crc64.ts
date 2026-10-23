/**
 * CRC-64/ISO as Go's `crc64.MakeTable(crc64.ISO)`: reflected polynomial 0xD800000000000000,
 * init 0, per update invert → process → invert. Computed on two 32-bit halves (no BigInt
 * in the loop). Values are returned as bigint.
 */
const TABLE_LO = new Uint32Array(256);
const TABLE_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let lo = i >>> 0;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const carry = lo & 1;
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    hi = hi >>> 1;
    if (carry) hi = (hi ^ 0xd8000000) >>> 0;
  }
  TABLE_LO[i] = lo;
  TABLE_HI[i] = hi;
}

export class Crc64 {
  #lo = 0;
  #hi = 0;
  update(data: Uint8Array): this {
    let lo = ~this.#lo >>> 0;
    let hi = ~this.#hi >>> 0;
    for (let i = 0; i < data.length; i++) {
      const idx = (lo ^ data[i]) & 0xff;
      lo = (((lo >>> 8) | (hi << 24)) ^ TABLE_LO[idx]) >>> 0;
      hi = ((hi >>> 8) ^ TABLE_HI[idx]) >>> 0;
    }
    this.#lo = ~lo >>> 0;
    this.#hi = ~hi >>> 0;
    return this;
  }
  digest(): bigint {
    return (BigInt(this.#hi) << 32n) | BigInt(this.#lo);
  }
}

export const crc64 = (...parts: Uint8Array[]): bigint => {
  const c = new Crc64();
  for (const p of parts) c.update(p);
  return c.digest();
};
