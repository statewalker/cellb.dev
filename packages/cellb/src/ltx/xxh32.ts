/** xxHash32 (seed 0 by default) — the LZ4 frame format's checksum. */
const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;
const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;

export function xxh32(data: Uint8Array, seed = 0): number {
  const len = data.length;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  let h: number;
  if (len >= 16) {
    let a = (seed + P1 + P2) >>> 0;
    let b = (seed + P2) >>> 0;
    let c = seed >>> 0;
    let d = (seed - P1) >>> 0;
    while (i <= len - 16) {
      a = mul(rotl((a + mul(v.getUint32(i, true), P2)) >>> 0, 13), P1);
      b = mul(rotl((b + mul(v.getUint32(i + 4, true), P2)) >>> 0, 13), P1);
      c = mul(rotl((c + mul(v.getUint32(i + 8, true), P2)) >>> 0, 13), P1);
      d = mul(rotl((d + mul(v.getUint32(i + 12, true), P2)) >>> 0, 13), P1);
      i += 16;
    }
    h = (rotl(a, 1) + rotl(b, 7) + rotl(c, 12) + rotl(d, 18)) >>> 0;
  } else h = (seed + P5) >>> 0;
  h = (h + len) >>> 0;
  while (i <= len - 4) {
    h = mul(rotl((h + mul(v.getUint32(i, true), P3)) >>> 0, 17), P4);
    i += 4;
  }
  while (i < len) {
    h = mul(rotl((h + mul(data[i], P5)) >>> 0, 11), P1);
    i++;
  }
  h = mul(h ^ (h >>> 15), P2);
  h = mul(h ^ (h >>> 13), P3);
  return (h ^ (h >>> 16)) >>> 0;
}
